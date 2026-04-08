#!/usr/bin/env tsx
/**
 * Diagnose vec0 vector health in the QMD SQLite index.
 *
 * Checks:
 *   - Total vector count
 *   - Embedding dimensionality
 *   - Pairwise cosine similarity across 10 random samples (collapsed vectors?)
 *   - Known-document differentiation (recipe vs concept vs journal)
 *   - Live test query via TEI → vec0
 *   - Embedding model label from content_vectors
 *
 * Usage:
 *   npx tsx scripts/diagnose-vectors.ts [--db /path/to/index.sqlite]
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { request as httpRequest } from "node:http";
import Database from "better-sqlite3";

// ── Config ───────────────────────────────────────────────────────────────────

const dbArg = process.argv.includes("--db")
  ? process.argv[process.argv.indexOf("--db") + 1]
  : null;

const DB_PATH = dbArg ?? `${homedir()}/.cache/qmd/index.sqlite`;
const TEI_PORT = Number(process.env.TEI_PORT ?? 8090);

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadDb(): InstanceType<typeof Database> {
  if (!existsSync(DB_PATH)) {
    console.error(`SQLite index not found: ${DB_PATH}`);
    process.exit(1);
  }

  const vec0Paths = [
    `${homedir()}/.npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-linux-x64/vec0`,
    `${homedir()}/.npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-arm64/vec0`,
    `${homedir()}/.npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-x64/vec0`,
    `/opt/homebrew/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-arm64/vec0`,
    `/usr/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-linux-x64/vec0`,
  ];

  let vec0Path: string | null = null;
  for (const base of vec0Paths) {
    if (existsSync(`${base}.so`) || existsSync(`${base}.dylib`)) {
      vec0Path = base;
      break;
    }
  }
  if (!vec0Path) {
    console.error("sqlite-vec vec0 extension not found — is QMD installed?");
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });
  db.loadExtension(vec0Path);
  return db;
}

/** Read a float32 little-endian buffer into a number array. */
function bufToVec(buf: Buffer): number[] {
  const vec: number[] = [];
  for (let i = 0; i < buf.byteLength; i += 4) {
    vec.push(buf.readFloatLE(i));
  }
  return vec;
}

/** Cosine similarity between two equal-length vectors. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/** Embed a query string via TEI. */
async function embedQuery(text: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const instructed = `Instruct: Given a search query, retrieve relevant passages from a personal knowledge vault\nQuery: ${text}`;
    const body = JSON.stringify({ input: instructed });
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: TEI_PORT,
        path: "/v1/embeddings",
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
            const parsed = JSON.parse(data);
            resolve(parsed.data[0].embedding as number[]);
          } catch {
            reject(new Error(`TEI parse error: ${data.slice(0, 300)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Pack a float32 vector into a little-endian Buffer for vec0 MATCH. */
function vecToBuf(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i], i * 4);
  }
  return buf;
}

/** Right-pad a string to a given width. */
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

async function main() {
  const db = loadDb();

  console.log("Vector Diagnostics");
  console.log("==================");

  // ── (a) Total vector count ───────────────────────────────────────────────
  const countRow = db.prepare("SELECT count(*) as n FROM vectors_vec").get() as { n: number };
  const totalVectors = countRow.n;
  console.log(`Total vectors:        ${totalVectors}`);

  if (totalVectors === 0) {
    console.log("\nNo vectors found — index may not have been built yet.");
    process.exit(0);
  }

  // ── (b) Dimensionality ───────────────────────────────────────────────────
  const sampleRow = db
    .prepare("SELECT embedding FROM vectors_vec LIMIT 1")
    .get() as { embedding: Buffer } | undefined;

  const dims = sampleRow ? Math.floor(sampleRow.embedding.byteLength / 4) : 0;
  console.log(`Dimensions:           ${dims}`);

  // ── (f) Embedding model label ────────────────────────────────────────────
  const modelRow = db
    .prepare("SELECT model FROM content_vectors GROUP BY model ORDER BY count(*) DESC LIMIT 1")
    .get() as { model: string } | undefined;
  console.log(`Embedding model:      ${modelRow?.model ?? "(unknown)"}`);
  console.log("");

  // ── (c) Pairwise cosine similarity on 10 random samples ─────────────────
  console.log("Pairwise Similarity (10 random samples):");

  const randomRows = db
    .prepare("SELECT embedding FROM vectors_vec ORDER BY RANDOM() LIMIT 10")
    .all() as { embedding: Buffer }[];

  const vecs = randomRows.map((r) => bufToVec(r.embedding));

  const similarities: number[] = [];
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      similarities.push(cosine(vecs[i], vecs[j]));
    }
  }

  if (similarities.length > 0) {
    const mean = similarities.reduce((s, v) => s + v, 0) / similarities.length;
    const min = Math.min(...similarities);
    const max = Math.max(...similarities);

    console.log(
      `  Mean: ${mean.toFixed(3)}   Min: ${min.toFixed(3)}   Max: ${max.toFixed(3)}`
    );

    const HIGH_THRESHOLD = 0.95;
    if (mean > HIGH_THRESHOLD) {
      console.log(`  WARNING: HIGH — vectors may not be differentiating well`);
    } else if (mean > 0.85) {
      console.log(`  CAUTION: Moderate similarity — may be acceptable`);
    } else {
      console.log(`  OK — vectors appear differentiated`);
    }
  } else {
    console.log("  (not enough vectors to compute)");
  }
  console.log("");

  // ── (d) Known-document check ─────────────────────────────────────────────
  console.log("Known-document check:");

  // Find one each of: recipe, concept, journal entry
  type DocRow = { hash: string; title: string; collection: string };

  // Match by path prefix since all documents share collection "life"
  const recipeDoc = db
    .prepare(
      `SELECT d.hash, d.title, d.collection
       FROM documents d
       WHERE d.active = 1
         AND (lower(d.path) LIKE '%/recipe%' OR lower(d.path) LIKE 'resources/recipe%')
       LIMIT 1`
    )
    .get() as DocRow | undefined;

  const conceptDoc = db
    .prepare(
      `SELECT d.hash, d.title, d.collection
       FROM documents d
       WHERE d.active = 1
         AND (lower(d.path) LIKE '%/concept%' OR lower(d.path) LIKE 'resources/concept%')
       LIMIT 1`
    )
    .get() as DocRow | undefined;

  // Journal: path contains journal/ segment (Journal/YYYY/YYYY-MM-DD)
  const journalDoc = db
    .prepare(
      `SELECT d.hash, d.title, d.collection
       FROM documents d
       WHERE d.active = 1
         AND lower(d.path) LIKE '%journal/%'
       LIMIT 1`
    )
    .get() as DocRow | undefined;

  /** Get first available vector for a document hash. */
  function getDocVec(hash: string): number[] | null {
    const row = db
      .prepare(
        "SELECT embedding FROM vectors_vec WHERE hash_seq LIKE ? || '%' LIMIT 1"
      )
      .get(hash) as { embedding: Buffer } | undefined;
    return row ? bufToVec(row.embedding) : null;
  }

  const knownDocs: Array<{ label: string; hash: string }> = [];
  if (recipeDoc) knownDocs.push({ label: recipeDoc.title, hash: recipeDoc.hash });
  if (conceptDoc) knownDocs.push({ label: conceptDoc.title, hash: conceptDoc.hash });
  if (journalDoc) knownDocs.push({ label: journalDoc.title, hash: journalDoc.hash });

  if (knownDocs.length < 2) {
    console.log("  (could not find enough distinct document types to compare)");
  } else {
    const docVecs = knownDocs.map((d) => ({ label: d.label, vec: getDocVec(d.hash) }));

    const labelWidth = Math.max(...knownDocs.map((d) => d.label.length)) + 2;

    for (let i = 0; i < docVecs.length; i++) {
      for (let j = i + 1; j < docVecs.length; j++) {
        const a = docVecs[i];
        const b = docVecs[j];
        const labelA = `"${a.label}"`;
        const labelB = `"${b.label}"`;

        if (!a.vec || !b.vec) {
          console.log(`  ${pad(labelA, labelWidth)} vs ${labelB}: (no vector found)`);
          continue;
        }

        const sim = cosine(a.vec, b.vec);
        const verdict = sim < 0.85 ? "✓ Different" : sim < 0.95 ? "~ Somewhat similar" : "✗ Possibly collapsed";
        console.log(
          `  ${pad(labelA, labelWidth)} vs ${pad(labelB, labelWidth + 5)}: cosine = ${sim.toFixed(3)}  ${verdict}`
        );
      }
    }
  }
  console.log("");

  // ── (e) Test query via TEI ───────────────────────────────────────────────
  console.log(`Test query "taste graph" top 5:`);

  let queryVec: number[];
  try {
    queryVec = await embedQuery("taste graph");
  } catch (err) {
    console.log(`  TEI unavailable (${(err as Error).message}) — skipping live query`);
    console.log("");
    db.close();
    return;
  }

  const queryBuf = vecToBuf(queryVec);

  const vecRows = db
    .prepare(
      `SELECT hash_seq, distance FROM vectors_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 15`
    )
    .all(queryBuf) as { hash_seq: string; distance: number }[];

  const seen = new Set<string>();
  let rank = 0;
  for (const { hash_seq, distance } of vecRows) {
    if (rank >= 5) break;
    const docHash = hash_seq.substring(0, hash_seq.lastIndexOf("_"));
    if (seen.has(docHash)) continue;
    seen.add(docHash);

    const doc = db
      .prepare("SELECT title FROM documents WHERE hash = ? AND active = 1")
      .get(docHash) as { title: string } | undefined;

    const title = doc?.title ?? `(hash: ${docHash.substring(0, 8)})`;
    rank++;
    console.log(`  ${rank}. ${title} (distance: ${distance.toFixed(3)})`);
  }

  if (rank === 0) {
    console.log("  (no results)");
  }

  console.log("");
  db.close();
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
