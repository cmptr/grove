/**
 * REST API handlers for the Grove note viewer.
 *
 * Provides GET /v1/notes/* and GET /v1/search endpoints.
 * These are thin facades over existing MCP tool logic,
 * designed for Next.js SSR fetching from grove-www.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { hybridSearch, bm25Search } from "./hybrid-search.js";
import { listNotes } from "./vault-ops.js";
import { parseNote, contentHash } from "./notes-validate.js";

const VAULT_PATH = process.env.GROVE_VAULT ?? join(homedir(), "life");

// ── Path traversal guard (same as server.ts) ────────────────────────

function sanitizePath(vaultRoot: string, filePath: string): string | null {
  const root = resolve(vaultRoot);
  const normalized = resolve(root, filePath);
  if (!normalized.startsWith(root + "/") && normalized !== root) return null;
  if (filePath.includes("..")) return null;
  try {
    const { isSymbolicLink } = statSync(normalized, { throwIfNoEntry: false }) ?? {};
    if (isSymbolicLink?.()) return null;
  } catch {
    // File doesn't exist — fine for reads
  }
  return normalized;
}

// ── Wikilink extraction ─────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

function extractWikilinks(text: string): string[] {
  const targets = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(WIKILINK_RE.source, "g");
  while ((m = re.exec(text)) !== null) targets.add(m[1].trim());
  return [...targets];
}

// ── Note resolution (extracted from server.ts get tool) ─────────────

interface ResolvedNote {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
  content_hash: string;
  resolved_from?: string;
}

async function resolveNote(file: string): Promise<ResolvedNote | null> {
  // 1. Normalize
  let filePath = file.replace(/^(life\/|qmd:\/\/life\/)/, "");
  if (!filePath.endsWith(".md")) filePath += ".md";

  const readNote = (abs: string, rel: string, resolvedFrom?: string): ResolvedNote => {
    const raw = readFileSync(abs, "utf-8");
    const { frontmatter, content } = parseNote(raw);
    const hash = contentHash(raw);
    const result: ResolvedNote = { path: rel, frontmatter, content, content_hash: hash };
    if (resolvedFrom) result.resolved_from = resolvedFrom;
    return result;
  };

  // 2. Direct path
  const abs = sanitizePath(VAULT_PATH, filePath);
  if (!abs) return null;
  if (existsSync(abs)) return readNote(abs, filePath);

  // 3. Extract basename for searching
  const searchTerm = filePath.replace(/\.md$/, "").split("/").pop() ?? file;

  // 4. Journal date pattern
  const dateMatch = searchTerm.match(/^(\d{4})-\d{2}-\d{2}$/);
  if (dateMatch) {
    const year = dateMatch[1];
    for (const y of [year, String(new Date().getFullYear())]) {
      const journalPath = `Journal/${y}/${searchTerm}.md`;
      const journalAbs = join(VAULT_PATH, journalPath);
      if (existsSync(journalAbs)) return readNote(journalAbs, journalPath, file);
    }
  }

  // 5. Case-insensitive basename search
  const searchLower = searchTerm.toLowerCase();
  const allNotes = listNotes(VAULT_PATH, "*");
  const nameMatch = allNotes.find((n) => n.name.toLowerCase() === searchLower);
  if (nameMatch) {
    const matchAbs = join(VAULT_PATH, nameMatch.path);
    if (existsSync(matchAbs)) return readNote(matchAbs, nameMatch.path, file);
  }

  // 6. Alias search
  const aliasNotes = listNotes(VAULT_PATH, "*", { includeAliases: true });
  const aliasMatch = aliasNotes.find(
    (n) => n.aliases?.some((a: string) => a.toLowerCase() === searchLower),
  );
  if (aliasMatch) {
    const matchAbs = join(VAULT_PATH, aliasMatch.path);
    if (existsSync(matchAbs)) return readNote(matchAbs, aliasMatch.path, file);
  }

  // 7. BM25 fallback
  try {
    const results = await bm25Search(searchTerm, 3);
    if (results.length > 0) {
      const resolved = results[0].file.replace(/^qmd:\/\/life\//, "");
      const resolvedLower = resolved.toLowerCase();
      const realNote = allNotes.find((n) => n.path.toLowerCase() === resolvedLower);
      const realPath = realNote?.path ?? resolved;
      const resolvedAbs = join(VAULT_PATH, realPath);
      if (existsSync(resolvedAbs)) return readNote(resolvedAbs, realPath, file);
    }
  } catch {
    // BM25 unavailable
  }

  return null;
}

// ── Backlinks computation ───────────────────────────────────────────
// Walks all .md files and finds notes that link TO the given path.
// Uses the same wikilink extraction as vault-graph.ts.

const SKIP = new Set([".obsidian", ".git", ".trash", "node_modules", ".claude"]);

function walkMd(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkMd(full, acc);
    else if (entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

// Cache backlinks index — rebuilt lazily, invalidated on a timer
let backlinkIndex: Map<string, string[]> | null = null;
let backlinkIndexAge = 0;
const BACKLINK_TTL_MS = 60_000; // rebuild every 60s max

function getBacklinkIndex(): Map<string, string[]> {
  if (backlinkIndex && Date.now() - backlinkIndexAge < BACKLINK_TTL_MS) {
    return backlinkIndex;
  }

  const index = new Map<string, string[]>();
  const files = walkMd(VAULT_PATH);

  for (const abs of files) {
    const srcPath = relative(VAULT_PATH, abs);
    const srcName = basename(abs, ".md");
    let text: string;
    try { text = readFileSync(abs, "utf-8"); } catch { continue; }

    const links = extractWikilinks(text);
    for (const target of links) {
      // Normalize target to just the note name (strip path prefixes)
      const targetName = target.split("/").pop() ?? target;
      if (!index.has(targetName)) index.set(targetName, []);
      index.get(targetName)!.push(srcPath);
    }
  }

  backlinkIndex = index;
  backlinkIndexAge = Date.now();
  return index;
}

function getBacklinks(notePath: string): string[] {
  const noteName = basename(notePath, ".md");
  const index = getBacklinkIndex();
  return index.get(noteName) ?? [];
}

// ── Wikilink resolution (batch) ─────────────────────────────────────
// For each wikilink target in a note, resolve it to a vault path.

async function resolveLinks(
  targets: string[],
): Promise<Record<string, { path: string | null; exists: boolean }>> {
  const allNotes = listNotes(VAULT_PATH, "*");
  const aliasNotes = listNotes(VAULT_PATH, "*", { includeAliases: true });
  const result: Record<string, { path: string | null; exists: boolean }> = {};

  for (const target of targets) {
    const searchLower = target.toLowerCase();
    // Strip any path prefixes — resolve by basename
    const searchName = target.split("/").pop()?.toLowerCase() ?? searchLower;

    // 1. Exact basename match
    const nameMatch = allNotes.find((n) => n.name.toLowerCase() === searchName);
    if (nameMatch) {
      result[target] = { path: nameMatch.path.replace(/\.md$/, ""), exists: true };
      continue;
    }

    // 2. Alias match
    const aliasMatch = aliasNotes.find(
      (n) => n.aliases?.some((a: string) => a.toLowerCase() === searchName),
    );
    if (aliasMatch) {
      result[target] = { path: aliasMatch.path.replace(/\.md$/, ""), exists: true };
      continue;
    }

    // 3. Not found
    result[target] = { path: null, exists: false };
  }

  return result;
}

// ── Public API ──────────────────────────────────────────────────────

export interface NoteResponse {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
  content_hash: string;
  links: Record<string, { path: string | null; exists: boolean }>;
  backlinks: string[];
  resolved_from?: string;
}

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
}

/**
 * Fetch a note by path or title. Returns note content, resolved wikilinks, and backlinks.
 */
export async function handleGetNote(notePath: string): Promise<NoteResponse | null> {
  const note = await resolveNote(notePath);
  if (!note) return null;

  // Extract and resolve wikilinks from content
  const targets = extractWikilinks(note.content);
  const links = await resolveLinks(targets);

  // Get backlinks
  const backlinks = getBacklinks(note.path);

  return {
    path: note.path,
    frontmatter: note.frontmatter,
    content: note.content,
    content_hash: note.content_hash,
    links,
    backlinks,
    ...(note.resolved_from && { resolved_from: note.resolved_from }),
  };
}

export interface ListEntry {
  path: string;
  name: string;
  type: string | null;
  tags: string[];
  modified_at: string;
}

/**
 * List notes under a path prefix. Returns metadata for each note.
 */
export function handleListNotes(prefix: string): ListEntry[] {
  // Ensure prefix ends with / for directory matching
  const dirPrefix = prefix.endsWith("/") ? prefix : prefix + "/";
  const allNotes = listNotes(VAULT_PATH, "*");

  return allNotes
    .filter((n) => n.path.startsWith(dirPrefix))
    .map((n) => ({
      path: n.path,
      name: n.name,
      type: n.type,
      tags: n.tags ?? [],
      modified_at: n.modified_at,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Search notes via hybrid search. Returns structured results.
 */
export async function handleSearch(query: string, limit: number = 10): Promise<SearchResult[]> {
  const results = await hybridSearch(query, limit);
  return results.map((r) => ({
    path: r.file.replace(/^qmd:\/\/life\//, ""),
    title: r.title,
    snippet: r.snippet ?? "",
    score: r.rrf_score,
  }));
}
