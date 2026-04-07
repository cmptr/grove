/**
 * Hybrid search: BM25 + vector via TEI + RRF fusion.
 *
 * - BM25: hits the QMD search server on port 8177
 * - Vector: embeds query via TEI on port 8090, then cosine search against
 *   pre-computed vectors in QMD's SQLite index
 * - RRF: fuses both result sets via Reciprocal Rank Fusion
 *
 * This runs entirely on the VPS. Doc vectors are pre-computed on Mac and
 * synced via scp. TEI embeds the query text (~85ms). No local LLM models.
 */

import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";

const TEI_PORT = Number(process.env.TEI_PORT ?? 8090);
const BM25_PORT = Number(process.env.BM25_PORT ?? 8177);
const QMD_INDEX = process.env.QMD_INDEX ?? `${process.env.HOME}/.cache/qmd/index.sqlite`;
const BM25_WEIGHT = parseFloat(process.env.BM25_WEIGHT ?? "1.2");
const VEC_WEIGHT = parseFloat(process.env.VEC_WEIGHT ?? "1.0");

interface SearchResult {
  file: string;
  title: string;
  score: number;
  snippet: string;
  docid?: string;
}

interface HybridResult {
  file: string;
  title: string;
  rrf_score: number;
  snippet: string;
  sources: string[]; // which backends contributed: ["bm25", "vector"]
}

/**
 * Embed a query string via TEI (localhost:8090)
 */
async function embedQuery(text: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    // Qwen3-Embedding uses instruction prefix for queries (not documents)
    const instructed = `Instruct: Given a search query, retrieve relevant passages from a personal knowledge vault\nQuery: ${text}`;
    const body = JSON.stringify({ model: "tei", input: instructed });
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
            resolve(parsed.data[0].embedding);
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

/**
 * BM25 search via QMD search server (localhost:8177)
 */
async function bm25Search(query: string, n: number): Promise<SearchResult[]> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: BM25_PORT,
        path: `/search?q=${encodeURIComponent(query)}&n=${n}`,
        method: "GET",
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`BM25 parse error`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// --- Lazy-initialized SQLite connection with vec0 extension ---

let _db: InstanceType<typeof Database> | null = null;

function getDb(): InstanceType<typeof Database> {
  if (_db) return _db;

  const vec0Paths = [
    `${homedir()}/.npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-linux-x64/vec0`,
    `${homedir()}/.npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-arm64/vec0`,
    `${homedir()}/.npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-x64/vec0`,
    `/opt/homebrew/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-arm64/vec0`,
    `/usr/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-linux-x64/vec0`,
  ];

  // better-sqlite3 adds the .so/.dylib extension automatically, but we need
  // to verify the file actually exists (check both extensions)
  let vec0Path: string | null = null;
  for (const base of vec0Paths) {
    if (existsSync(`${base}.so`) || existsSync(`${base}.dylib`)) {
      vec0Path = base;
      break;
    }
  }
  if (!vec0Path) {
    throw new Error("sqlite-vec vec0 extension not found");
  }

  const db = new Database(QMD_INDEX, { readonly: true });
  db.loadExtension(vec0Path);
  _db = db;
  return db;
}

/**
 * Vector search: embed query via TEI, then cosine search via sqlite-vec.
 */
async function vectorSearch(query: string, n: number): Promise<SearchResult[]> {
  const queryVec = await embedQuery(query);

  // Pack float32 vector into a little-endian buffer
  const buf = Buffer.alloc(queryVec.length * 4);
  for (let i = 0; i < queryVec.length; i++) {
    buf.writeFloatLE(queryVec[i], i * 4);
  }

  const db = getDb();

  // Oversample to allow deduplication by file
  const rows = db
    .prepare(
      `SELECT hash_seq, distance FROM vectors_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    )
    .all(buf, n * 3) as { hash_seq: string; distance: number }[];

  const results: SearchResult[] = [];
  const seenFiles = new Set<string>();

  for (const { hash_seq, distance } of rows) {
    const docHash = hash_seq.substring(0, hash_seq.lastIndexOf("_"));

    const doc = db
      .prepare("SELECT path, title, collection FROM documents WHERE hash = ? AND active = 1")
      .get(docHash) as { path: string; title: string; collection: string } | undefined;
    if (!doc) continue;

    const filePath = doc.collection ? `qmd://${doc.collection}/${doc.title}` : doc.title;
    if (seenFiles.has(filePath)) continue;
    seenFiles.add(filePath);

    // Get snippet from content table
    let snippet = "";
    const content = db
      .prepare("SELECT doc FROM content WHERE hash = ?")
      .get(docHash) as { doc: string } | undefined;
    if (content) {
      let text = content.doc;
      // Strip YAML frontmatter
      if (text.startsWith("---\n")) {
        const end = text.indexOf("\n---\n", 4);
        if (end !== -1) text = text.substring(end + 5);
      }
      snippet = text.trim().substring(0, 200);
    }

    results.push({
      file: filePath,
      title: doc.title,
      score: Math.round((1.0 - distance) * 10000) / 10000,
      snippet,
      docid: `#${docHash.substring(0, 6)}`,
    });

    if (results.length >= n) break;
  }

  return results;
}

/**
 * RRF fusion: merge two ranked lists
 */
function rrfFuse(
  lists: { results: SearchResult[]; weight: number; label: string }[],
  n: number,
  k = 60
): HybridResult[] {
  const scores: Record<string, number> = {};
  const meta: Record<string, SearchResult> = {};
  const sources: Record<string, Set<string>> = {};

  for (const { results, weight, label } of lists) {
    for (let rank = 0; rank < results.length; rank++) {
      const key = results[rank].file;
      scores[key] = (scores[key] ?? 0) + weight / (k + rank);
      if (!meta[key]) meta[key] = results[rank];
      if (!sources[key]) sources[key] = new Set();
      sources[key].add(label);
    }
  }

  return Object.keys(scores)
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, n)
    .map((key) => ({
      file: meta[key].file,
      title: meta[key].title,
      rrf_score: Math.round(scores[key] * 10000) / 10000,
      snippet: meta[key].snippet,
      sources: [...(sources[key] ?? [])],
    }));
}

/**
 * Hybrid search: BM25 + vector with RRF fusion.
 * Runs both backends in parallel. Falls back to BM25-only if vector
 * search fails (TEI down, vec0 missing, etc.).
 */
export async function hybridSearch(
  query: string,
  limit: number = 10
): Promise<HybridResult[]> {
  const oversample = Math.min(limit * 5, 50);

  const [bm25, vec] = await Promise.all([
    bm25Search(query, oversample),
    vectorSearch(query, oversample).catch((err) => {
      console.error(`[hybrid] vector search failed, falling back to BM25-only: ${err.message}`);
      return null;
    }),
  ]);

  if (!vec) {
    // BM25-only fallback
    return bm25.slice(0, limit).map((r) => ({
      file: r.file,
      title: r.title,
      rrf_score: r.score,
      snippet: r.snippet,
      sources: ["bm25"],
    }));
  }

  const lists: { results: SearchResult[]; weight: number; label: string }[] = [
    { results: bm25, weight: BM25_WEIGHT, label: "bm25" },
    { results: vec, weight: VEC_WEIGHT, label: "vector" },
  ];

  return rrfFuse(lists, limit);
}

/**
 * Format hybrid results as text for MCP response
 */
export function formatResults(results: HybridResult[]): string {
  if (results.length === 0) return "No results found.";
  return results
    .map(
      (r) =>
        `**${r.title}** (${r.file}, score: ${r.rrf_score})\n${r.snippet ?? ""}`
    )
    .join("\n\n---\n\n");
}

export { embedQuery, bm25Search, vectorSearch };
