#!/usr/bin/env tsx
/**
 * Embed all docs via TEI (SSH tunnel) + insert into SQLite vec0.
 * No Python, no PyTorch, no GC issues.
 *
 * Prerequisites:
 *   ssh -f -N -L 18090:localhost:8090 mili   # tunnel to VPS TEI
 *
 * Usage:
 *   npx tsx src/embed-node.ts
 */

import Database from "better-sqlite3";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { request } from "node:http";

const DB_PATH = `${homedir()}/.cache/qmd/index.sqlite`;
const TEI_URL = process.env.TEI_URL ?? "http://localhost:18090";
const CHUNK_SIZE = 1200; // TEI max 512 tokens; ~3 chars/token with markup
const CHUNK_OVERLAP = 180;
const BATCH = 8; // TEI CPU batch limit
const MODEL_LABEL = "qwen3-embedding-0.6b";

// Find vec0 extension
function findVec0(): string {
  const paths = [
    `${homedir()}/.npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-arm64/vec0`,
    `${homedir()}/.npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-linux-x64/vec0`,
    `/opt/homebrew/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-arm64/vec0`,
    `/usr/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-linux-x64/vec0`,
  ];
  for (const p of paths) {
    if (existsSync(`${p}.dylib`) || existsSync(`${p}.so`)) return p;
  }
  throw new Error("vec0 extension not found");
}

function chunkText(text: string, title: string): { pos: number; text: string }[] {
  const full = title ? `${title}\n\n${text}` : text;
  if (full.length <= CHUNK_SIZE) return [{ pos: 0, text: full }];

  const chunks: { pos: number; text: string }[] = [];
  let start = 0;
  while (start < full.length) {
    let end = Math.min(start + CHUNK_SIZE, full.length);
    if (end < full.length) {
      const sl = full.slice(start, end);
      const lastPara = sl.lastIndexOf("\n\n");
      const lastNl = sl.lastIndexOf("\n");
      if (lastPara > CHUNK_SIZE * 0.5) end = start + lastPara + 2;
      else if (lastNl > CHUNK_SIZE * 0.5) end = start + lastNl + 1;
    }
    chunks.push({ pos: start, text: full.slice(start, end) });
    const nextStart = end - CHUNK_OVERLAP;
    start = nextStart > start ? nextStart : end; // always advance
    if (start >= full.length) break;
  }
  return chunks;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const url = new URL(`${TEI_URL}/v1/embeddings`);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: "tei", input: texts });
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const result = JSON.parse(data);
            const embs: number[][] = new Array(texts.length);
            for (const item of result.data) {
              embs[item.index] = item.embedding;
            }
            resolve(embs);
          } catch (err) {
            reject(new Error(`TEI parse error: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function float32Buffer(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

async function main() {
  console.log("Opening database...");
  const db = new Database(DB_PATH);
  db.loadExtension(findVec0());
  db.pragma("journal_mode = WAL");

  // Read docs
  const docs = db
    .prepare("SELECT hash, title FROM documents WHERE active=1")
    .all() as { hash: string; title: string }[];
  const embedded = new Set(
    (
      db
        .prepare("SELECT DISTINCT hash FROM content_vectors WHERE model=?")
        .all(MODEL_LABEL) as { hash: string }[]
    ).map((r) => r.hash)
  );
  const todo = docs.filter((d) => !embedded.has(d.hash));
  console.log(`  ${todo.length}/${docs.length} need embedding`);

  // Build chunks
  interface Chunk {
    hash: string;
    seq: number;
    pos: number;
    text: string;
  }
  const chunks: Chunk[] = [];
  for (const doc of todo) {
    const row = db
      .prepare("SELECT doc FROM content WHERE hash=?")
      .get(doc.hash) as { doc: string } | undefined;
    if (!row) continue;
    let body = row.doc;
    if (body.startsWith("---\n")) {
      const end = body.indexOf("\n---\n", 4);
      if (end !== -1) body = body.slice(end + 5);
    }
    body = body.trim();
    if (!body) continue;
    for (const [seq, c] of chunkText(body, doc.title).entries()) {
      chunks.push({ hash: doc.hash, seq, pos: c.pos, text: c.text });
    }
  }
  console.log(`  ${chunks.length} chunks`);

  if (chunks.length === 0) {
    console.log("Nothing to embed.");
    db.close();
    return;
  }

  // Prepare statements
  const insertCV = db.prepare(
    "INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?,?,?,?,datetime('now'))"
  );
  const insertVec = db.prepare(
    "INSERT OR REPLACE INTO vectors_vec (hash_seq, embedding) VALUES (?,?)"
  );

  // Embed + insert per batch
  const nBatches = Math.ceil(chunks.length / BATCH);
  let total = 0;
  const t0 = Date.now();

  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const bn = Math.floor(i / BATCH) + 1;
    const t = Date.now();

    const texts = batch.map((c) => c.text);
    const embs = await embedBatch(texts);

    const tx = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const c = batch[j];
        const hashSeq = `${c.hash}_${c.seq}`;
        insertCV.run(c.hash, c.seq, c.pos, MODEL_LABEL);
        insertVec.run(hashSeq, float32Buffer(embs[j]));
      }
    });
    tx();
    total += batch.length;

    const elapsed = ((Date.now() - t) / 1000).toFixed(1);
    console.log(
      `  Batch ${bn}/${nBatches}: ${batch.length} chunks, ${elapsed}s (${total}/${chunks.length})`
    );
  }

  const count = (
    db
      .prepare("SELECT COUNT(*) as n FROM content_vectors WHERE model=?")
      .get(MODEL_LABEL) as { n: number }
  ).n;
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\nDone! ${count} embeddings in ${elapsed}s.`);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
