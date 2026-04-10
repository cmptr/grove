/**
 * Hybrid search: BM25 + vector + RRF fusion.
 *
 * - BM25: FTS5 full-text search directly against QMD's SQLite index
 * - Vector: embeds query via Voyage AI API, then cosine
 *   search against pre-computed vectors in QMD's SQLite vec0 table
 * - RRF: fuses both result sets via Reciprocal Rank Fusion
 */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY ?? "";
const VOYAGE_MODEL = process.env.VOYAGE_MODEL ?? "voyage-4-large";
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
 * Embed a query string via Voyage AI API.
 */
async function embedQuery(text: string): Promise<number[]> {
  if (!VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY not set");
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: text,
      model: VOYAGE_MODEL,
      input_type: "query",
    }),
  });
  if (!res.ok) throw new Error(`Voyage API error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data[0].embedding;
}

/**
 * BM25 search via FTS5 directly against QMD's SQLite index.
 */
function bm25Search(query: string, n: number): SearchResult[] {
  const db = getDb();

  // Escape FTS5 special characters and wrap terms for safe matching
  const sanitized = query.replace(/['"]/g, "").trim();
  if (!sanitized) return [];

  const rows = db
    .prepare(
      `SELECT f.filepath, f.title, rank,
              substr(f.body, 1, 200) as snippet
       FROM documents_fts f
       JOIN documents d ON d.path = f.filepath AND d.active = 1
       WHERE documents_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(sanitized, n * 2) as { filepath: string; title: string; rank: number; snippet: string }[];

  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.title)) continue;
    seen.add(row.title);

    // Normalize score: FTS5 rank is negative (more negative = better match)
    const score = Math.round(Math.abs(row.rank) * 100) / 100;
    const collection = db
      .prepare("SELECT collection FROM documents WHERE path = ? AND active = 1")
      .get(row.filepath) as { collection: string } | undefined;

    const file = collection?.collection
      ? `qmd://${collection.collection}/${row.title}`
      : row.title;

    results.push({
      file,
      title: row.title,
      score,
      snippet: row.snippet?.trim().substring(0, 200) ?? "",
    });

    if (results.length >= n) break;
  }

  return results;
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

  // Oversample aggressively to allow re-ranking after dedup
  const rows = db
    .prepare(
      `SELECT hash_seq, distance FROM vectors_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    )
    .all(buf, n * 5) as { hash_seq: string; distance: number }[];

  const candidates: (SearchResult & { path: string })[] = [];
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

    let score = 1.0 - distance;

    // Boost Resource/concept notes — they're higher signal than journal entries
    if (doc.path.startsWith("Resources/")) score *= 1.15;
    // Slight penalty for raw journal entries and source captures
    if (/^Journal\/|^Sources\//.test(doc.path)) score *= 0.90;

    candidates.push({
      file: filePath,
      title: doc.title,
      score: Math.round(score * 10000) / 10000,
      snippet,
      docid: `#${docHash.substring(0, 6)}`,
      path: doc.path,
    });
  }

  // Re-rank by adjusted score
  candidates.sort((a, b) => b.score - a.score);

  return candidates.slice(0, n).map(({ path: _, ...rest }) => rest);
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

  let bm25: SearchResult[] = [];
  try {
    bm25 = bm25Search(query, oversample);
  } catch (err) {
    console.error(`[hybrid] BM25 search failed: ${(err as Error).message}`);
  }

  const vec = await vectorSearch(query, oversample).catch((err) => {
    console.error(`[hybrid] vector search failed, falling back to BM25-only: ${err.message}`);
    return null;
  });

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
