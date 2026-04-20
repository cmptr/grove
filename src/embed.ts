#!/usr/bin/env tsx
/**
 * Grove embeddings — pre-compute embeddings via OpenAI API and insert
 * into QMD's SQLite database. Replaces local model inference entirely.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npx tsx src/embed.ts [--db path] [--force]
 *
 * This script:
 * 1. Reads all documents from QMD's index
 * 2. Chunks them (matching QMD's chunking logic)
 * 3. Embeds via OpenAI text-embedding-3-small (768 dims to match QMD schema)
 * 4. Inserts vectors into QMD's SQLite vec0 table
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { isSearchIndexLocked } from "./index-crypto.js";

const DB_PATH = process.argv.includes("--db")
  ? process.argv[process.argv.indexOf("--db") + 1]
  : join(homedir(), ".cache", "qmd", "index.sqlite");
const FORCE = process.argv.includes("--force");
const MODEL = "text-embedding-3-small";
const DIMENSIONS = 768; // Match QMD's existing vec0 table
const CHUNK_SIZE = 3600; // ~900 tokens, matching QMD's default
const CHUNK_OVERLAP = 540; // 15% overlap
const BATCH_SIZE = 100; // OpenAI supports up to 2048 inputs per call
const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
  console.error("OPENAI_API_KEY is required");
  process.exit(1);
}

interface DocRow {
  hash: string;
  path: string;
  title: string;
  collection: string;
}

interface ContentRow {
  hash: string;
  doc: string;
}

interface Chunk {
  hash: string;
  seq: number;
  pos: number;
  text: string;
}

function chunkText(text: string, title: string): { pos: number; text: string }[] {
  // Prepend title for embedding context
  const fullText = title ? `${title}\n\n${text}` : text;

  if (fullText.length <= CHUNK_SIZE) {
    return [{ pos: 0, text: fullText }];
  }

  const chunks: { pos: number; text: string }[] = [];
  let start = 0;

  while (start < fullText.length) {
    let end = Math.min(start + CHUNK_SIZE, fullText.length);

    // Try to break at paragraph boundary
    if (end < fullText.length) {
      const slice = fullText.slice(start, end);
      const lastPara = slice.lastIndexOf("\n\n");
      const lastNewline = slice.lastIndexOf("\n");

      if (lastPara > CHUNK_SIZE * 0.5) {
        end = start + lastPara + 2;
      } else if (lastNewline > CHUNK_SIZE * 0.5) {
        end = start + lastNewline + 1;
      }
    }

    chunks.push({ pos: start, text: fullText.slice(start, end) });
    start = end - CHUNK_OVERLAP;
    if (start >= fullText.length) break;
  }

  return chunks;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      input: texts,
      dimensions: DIMENSIONS,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as {
    data: { embedding: number[]; index: number }[];
    usage: { total_tokens: number };
  };

  // Log token usage
  console.log(`  Batch: ${texts.length} texts, ${data.usage.total_tokens} tokens`);

  // Sort by index to match input order
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

function float32Buffer(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i], i * 4);
  }
  return buf;
}

async function main() {
  if (isSearchIndexLocked()) {
    console.error("Search index is encrypted and locked. Unlock the vault before running embed.");
    process.exit(2);
  }
  console.log(`Opening database: ${DB_PATH}`);
  const db = new Database(DB_PATH);

  // Load sqlite-vec extension
  // QMD uses sqlite-vec for vector search. We need it loaded to insert into vec0 tables.
  // Try to find the extension
  const vecExtPaths = [
    join(homedir(), ".cache/qmd/vec0"),
    "/usr/lib/sqlite3/vec0",
    "/usr/local/lib/sqlite3/vec0",
  ];

  // Actually, better-sqlite3 may not support vec0 directly.
  // Let's check if the table exists and what we're working with.
  const vecSchema = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'vectors_vec'")
    .get() as { sql: string } | undefined;

  if (!vecSchema) {
    console.error("vectors_vec table not found. Has QMD been initialized?");
    process.exit(1);
  }
  console.log(`Vector table: ${vecSchema.sql}`);

  // Get all documents that need embedding
  const docs = db
    .prepare(
      `SELECT d.hash, d.path, d.title, d.collection
       FROM documents d
       WHERE d.active = 1`
    )
    .all() as DocRow[];

  console.log(`Total documents: ${docs.length}`);

  // Check which are already embedded (unless --force)
  let toEmbed = docs;
  if (!FORCE) {
    const embedded = new Set(
      (
        db
          .prepare(
            `SELECT DISTINCT hash FROM content_vectors WHERE model = ?`
          )
          .all(`openai/${MODEL}`) as { hash: string }[]
      ).map((r) => r.hash)
    );
    toEmbed = docs.filter((d) => !embedded.has(d.hash));
    console.log(`Already embedded: ${embedded.size}, remaining: ${toEmbed.length}`);
  }

  if (toEmbed.length === 0) {
    console.log("All documents already embedded. Use --force to re-embed.");
    return;
  }

  // Prepare all chunks
  const allChunks: Chunk[] = [];
  for (const doc of toEmbed) {
    const content = db
      .prepare("SELECT doc FROM content WHERE hash = ?")
      .get(doc.hash) as ContentRow | undefined;
    if (!content) continue;

    // Strip YAML frontmatter
    let body = content.doc;
    const fmMatch = body.match(/^---\n[\s\S]*?\n---\n/);
    if (fmMatch) body = body.slice(fmMatch[0].length);

    const chunks = chunkText(body.trim(), doc.title);
    for (let seq = 0; seq < chunks.length; seq++) {
      allChunks.push({
        hash: doc.hash,
        seq,
        pos: chunks[seq].pos,
        text: chunks[seq].text,
      });
    }
  }

  console.log(`Total chunks to embed: ${allChunks.length}`);

  // Clear old embeddings for docs we're re-embedding
  if (FORCE) {
    console.log("Clearing old embeddings...");
    db.prepare("DELETE FROM content_vectors").run();
    db.prepare("DELETE FROM vectors_vec").run();
  } else {
    // Only clear for documents we're about to re-embed
    const hashesToClear = [...new Set(toEmbed.map((d) => d.hash))];
    const deleteCV = db.prepare("DELETE FROM content_vectors WHERE hash = ?");
    const deleteVV = db.prepare("DELETE FROM vectors_vec WHERE hash_seq LIKE ? || '_%'");
    for (const hash of hashesToClear) {
      deleteCV.run(hash);
      deleteVV.run(hash);
    }
  }

  // Embed in batches
  const insertCV = db.prepare(
    `INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embedded_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insertVV = db.prepare(
    `INSERT OR REPLACE INTO vectors_vec (hash_seq, embedding)
     VALUES (?, ?)`
  );

  let totalTokens = 0;
  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.text);

    console.log(
      `Embedding batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allChunks.length / BATCH_SIZE)}...`
    );

    const embeddings = await embedBatch(texts);

    const insertAll = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const now = new Date().toISOString();
        insertCV.run(chunk.hash, chunk.seq, chunk.pos, `openai/${MODEL}`, now);
        insertVV.run(`${chunk.hash}_${chunk.seq}`, float32Buffer(embeddings[j]));
      }
    });
    insertAll();
  }

  // Verify
  const count = db
    .prepare("SELECT COUNT(*) as n FROM content_vectors WHERE model = ?")
    .get(`openai/${MODEL}`) as { n: number };
  console.log(`\nDone! ${count.n} embeddings stored.`);
  console.log(`Model: openai/${MODEL} (${DIMENSIONS} dimensions)`);

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
