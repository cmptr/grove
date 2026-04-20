/**
 * REST API handlers for the Grove note viewer.
 *
 * Provides GET /v1/notes/*, GET /v1/search, GET /v1/status/:mode endpoints.
 * These are thin facades over existing MCP tool logic,
 * designed for Next.js SSR fetching from grove-www.
 */

import { existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, relative, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { hybridSearch, bm25Search } from "./hybrid-search.js";
import {
  gitLog,
  listNotes,
  gitCommit,
  qmdReindex,
  gitPush,
  readNoteFile,
  writeNoteFile,
  invalidateFrontmatterCache,
} from "./vault-ops.js";
import { validatePath, validateNote, parseNote, serializeNote, contentHash } from "./notes-validate.js";
import { loadVaultConfig } from "./vault-config.js";
import { filterByTrail, trailAllowsWrite, getTrailPublicInfo, getTrailConfig, type TrailConfig, type NoteMetadata } from "./trails.js";
import { getStats, refreshStats } from "./vault-stats.js";
import { analyzeGraph, computeDigest } from "./vault-graph.js";
import { searchMetrics, metrics } from "./metrics.js";
import { WriteQueue } from "./write-queue.js";
import { embedFile } from "./embed-single.js";
import { enqueueDiscovery } from "./db.js";
import { getImageStore, contentKey, extForContentType, type ImageStore } from "./image-store.js";
import { autoTagImage, type ImageTagResult } from "./image-tag.js";

const VAULT_PATH = process.env.GROVE_VAULT ?? join(homedir(), "life");

// ── Shared write queue (serializes all writes within this process) ──

const writeQueue = new WriteQueue();
writeQueue.schedulePush(() => gitPush(VAULT_PATH));

/** Flush pending writes and push — call on graceful shutdown. */
export async function flushWriteQueue(): Promise<void> {
  await writeQueue.flush();
}

/** Encode a vault path as a valid URL (encode each segment, preserve slashes) */
function noteUrl(vaultPath: string): string {
  const stripped = vaultPath.replace(/\.md$/, "");
  const encoded = stripped.split("/").map(encodeURIComponent).join("/");
  return `https://grove.md/${encoded}`;
}

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
    const raw = readNoteFile(abs);
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

  // 3. Case-insensitive full path match (handles Resources/ vs resources/)
  const allNotes = listNotes(VAULT_PATH, "*");
  const filePathLower = filePath.toLowerCase();
  const pathMatch = allNotes.find((n) => n.path.toLowerCase() === filePathLower);
  if (pathMatch) {
    const matchAbs = join(VAULT_PATH, pathMatch.path);
    if (existsSync(matchAbs)) return readNote(matchAbs, pathMatch.path, file);
  }

  // 4. Extract basename for searching
  const searchTerm = filePath.replace(/\.md$/, "").split("/").pop() ?? file;

  // 5. Journal date pattern
  const dateMatch = searchTerm.match(/^(\d{4})-\d{2}-\d{2}$/);
  if (dateMatch) {
    const year = dateMatch[1];
    for (const y of [year, String(new Date().getFullYear())]) {
      const journalPath = `Journal/${y}/${searchTerm}.md`;
      const journalAbs = join(VAULT_PATH, journalPath);
      if (existsSync(journalAbs)) return readNote(journalAbs, journalPath, file);
    }
  }

  // 6. Case-insensitive basename search
  const searchLower = searchTerm.toLowerCase();
  const nameMatch = allNotes.find((n) => n.name.toLowerCase() === searchLower);
  if (nameMatch) {
    const matchAbs = join(VAULT_PATH, nameMatch.path);
    if (existsSync(matchAbs)) return readNote(matchAbs, nameMatch.path, file);
  }

  // 6b. Kebab-case basename match (QMD index uses kebab-case, filesystem uses spaces/punctuation)
  const toKebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const searchKebab = toKebab(searchTerm);
  const kebabMatch = allNotes.find((n) => toKebab(n.name) === searchKebab);
  if (kebabMatch) {
    const matchAbs = join(VAULT_PATH, kebabMatch.path);
    if (existsSync(matchAbs)) return readNote(matchAbs, kebabMatch.path, file);
  }

  // 7. Alias search
  const aliasNotes = listNotes(VAULT_PATH, "*", { includeAliases: true });
  const aliasMatch = aliasNotes.find(
    (n) => n.aliases?.some((a: string) => a.toLowerCase() === searchLower),
  );
  if (aliasMatch) {
    const matchAbs = join(VAULT_PATH, aliasMatch.path);
    if (existsSync(matchAbs)) return readNote(matchAbs, aliasMatch.path, file);
  }

  // 8. BM25 fallback
  try {
    const results = await bm25Search(searchTerm, 3);
    if (results.length > 0) {
      const resolvedLower = results[0].vault_path.toLowerCase();
      const realNote = allNotes.find((n) => n.path.toLowerCase() === resolvedLower);
      const realPath = realNote?.path ?? results[0].vault_path;
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
    try { text = readNoteFile(abs); } catch { continue; }

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

// ── Trail info (unauthenticated) ──────────────────────────────────

export interface TrailInfoResponse {
  name: string;
  description: string;
  note_count: number;
  created_at: string;
}

export function handleTrailInfo(trailId: string): TrailInfoResponse | null {
  const info = getTrailPublicInfo(trailId);
  if (!info || !info.enabled) return null;

  // Count notes matching trail filters
  const config = getTrailConfig(trailId);
  let noteCount = 0;
  if (config) {
    const allNotes = listNotes(VAULT_PATH, "*");
    noteCount = allNotes.filter((n) => {
      const meta: NoteMetadata = {
        path: n.path,
        type: n.type ?? undefined,
        tags: n.tags ?? [],
        private: n.private,
      };
      return filterByTrail(config, meta);
    }).length;
  }

  return {
    name: info.name,
    description: info.description,
    note_count: noteCount,
    created_at: info.created_at,
  };
}

/**
 * Fetch a note by path or title. Returns note content, resolved wikilinks, and backlinks.
 * If a trail is provided, applies trail filtering (returns null for hidden notes).
 */
export async function handleGetNote(notePath: string, trail?: TrailConfig | null): Promise<NoteResponse | null> {
  const note = await resolveNote(notePath);
  if (!note) return null;

  // Trail filter: if note not visible, return null (404, not 403)
  if (trail) {
    const tags = Array.isArray(note.frontmatter.tags) ? note.frontmatter.tags as string[] :
      typeof note.frontmatter.tags === "string" ? [note.frontmatter.tags] : [];
    const meta: NoteMetadata = {
      path: note.path,
      type: note.frontmatter.type as string | undefined,
      tags,
      private: note.frontmatter.private === true,
    };
    if (!filterByTrail(trail, meta)) return null;
  }

  // Extract and resolve wikilinks from content
  const targets = extractWikilinks(note.content);
  const links = await resolveLinks(targets);

  // Trail filter wikilinks: mark trail-invisible notes as non-existent
  if (trail) {
    for (const [target, info] of Object.entries(links)) {
      if (info.exists && info.path) {
        try {
          const linkAbs = join(VAULT_PATH, info.path + ".md");
          const raw = readNoteFile(linkAbs);
          const { frontmatter } = parseNote(raw);
          const linkTags = Array.isArray(frontmatter.tags) ? frontmatter.tags as string[] : [];
          const linkMeta: NoteMetadata = {
            path: info.path + ".md",
            type: frontmatter.type as string | undefined,
            tags: linkTags,
            private: frontmatter.private === true,
          };
          if (!filterByTrail(trail, linkMeta)) {
            links[target] = { path: null, exists: false };
          }
        } catch {
          links[target] = { path: null, exists: false };
        }
      }
    }
  }

  // Get backlinks (filter by trail if scoped)
  let backlinks = getBacklinks(note.path);
  if (trail) {
    backlinks = backlinks.filter((bl) => {
      try {
        const abs = join(VAULT_PATH, bl);
        const raw = readNoteFile(abs);
        const { frontmatter } = parseNote(raw);
        const blTags = Array.isArray(frontmatter.tags) ? frontmatter.tags as string[] : [];
        const blMeta: NoteMetadata = {
          path: bl,
          type: frontmatter.type as string | undefined,
          tags: blTags,
          private: frontmatter.private === true,
        };
        return filterByTrail(trail, blMeta);
      } catch { return false; }
    });
  }

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
 * If a trail is provided, filters to trail-visible notes only.
 */
export function handleListNotes(prefix: string, trail?: TrailConfig | null): ListEntry[] {
  // Empty prefix means "list all notes" (for sidebar folder discovery)
  const dirPrefix = prefix === "" ? "" : (prefix.endsWith("/") ? prefix : prefix + "/");
  const allNotes = listNotes(VAULT_PATH, "*");

  return allNotes
    .filter((n) => {
      if (dirPrefix !== "" && !n.path.startsWith(dirPrefix)) return false;
      if (trail) {
        const meta: NoteMetadata = {
          path: n.path,
          type: n.type ?? undefined,
          tags: n.tags ?? [],
          private: n.private,
        };
        return filterByTrail(trail, meta);
      }
      return true;
    })
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
 * If a trail is provided, filters results to trail-visible notes.
 */
export async function handleSearch(query: string, limit: number = 10, trail?: TrailConfig | null): Promise<SearchResult[]> {
  const fetchLimit = trail ? limit * 3 : limit; // over-fetch for trail filtering
  const results = await hybridSearch(query, fetchLimit);

  // Resolve QMD's lowercase-kebab paths to real filesystem paths.
  // QMD index stores e.g. "resources/concepts/meditation-mindfulness.md"
  // but the filesystem has "Resources/Concepts/Meditation & Mindfulness.md".
  const allNotes = listNotes(VAULT_PATH, "*");
  const resolveRealPath = (vaultPath: string, title: string): string => {
    const vp = vaultPath.toLowerCase();
    const note = allNotes.find((n) => n.path.toLowerCase() === vp || n.name === title);
    return note?.path ?? vaultPath;
  };

  let filtered = results.map((r) => {
    const realPath = resolveRealPath(r.vault_path, r.title);
    return {
      path: realPath,
      title: r.title,
      snippet: r.snippet ?? "",
      score: r.rrf_score,
      vault_path: r.vault_path,
      real_path: realPath,
      url: "https://grove.md/" + realPath.replace(/\.md$/, "").split("/").map(encodeURIComponent).join("/"),
    };
  });

  if (trail) {
    filtered = filtered.filter((r) => {
      const note = allNotes.find((n) => n.path === r.real_path);
      if (!note) return false;
      const meta: NoteMetadata = {
        path: note.path,
        type: note.type ?? undefined,
        tags: note.tags ?? [],
        private: note.private,
      };
      return filterByTrail(trail, meta);
    });
  }

  // Strip internal fields from response
  return filtered.slice(0, limit).map(({ vault_path: _, real_path: _rp, ...rest }) => rest);
}

const VALID_STATS_SECTIONS = new Set(["vault", "freshness", "graph", "index", "lifecycle", "git", "search", "server"]);

/**
 * Get precomputed vault statistics, optionally filtered by section.
 * Returns null if stats haven't been computed yet.
 */
export function handleStats(
  sections?: string[],
  trail?: TrailConfig | null,
  isAdmin?: boolean,
): Record<string, unknown> | null {
  const stats = getStats(VAULT_PATH);
  if (!stats) return null;

  const result: Record<string, unknown> = {
    computed_at: stats.computed_at,
  };

  // If trail is active, note that stats are vault-wide
  if (trail) {
    result.trail_note = "stats are vault-wide, not trail-scoped";
  }

  const include = (key: string): boolean =>
    !sections || sections.includes(key);

  if (include("vault")) result.vault = stats.vault;
  if (include("freshness")) result.freshness = stats.freshness;
  if (include("graph")) result.graph = stats.graph;
  if (include("index")) result.index = stats.index;
  if (include("lifecycle")) result.lifecycle = stats.lifecycle;
  if (include("git")) result.git = stats.git;

  // Search stats are admin-only
  if (include("search") && isAdmin) {
    result.search = searchMetrics.getSearchStats();
  }

  // Server metrics
  if (include("server")) {
    const m = metrics.getMetrics();
    result.server = {
      started_at: m.started_at,
      uptime_seconds: m.uptime_seconds,
      total_requests: m.total_requests,
      error_rate: m.error_rate,
    };
  }

  return result;
}

// ── Status endpoints (vault_status modes via REST) ─────────────────

export type StatusMode = "health" | "history" | "diagnostics" | "graph" | "digest";

export const VALID_STATUS_MODES = new Set<StatusMode>(["health", "history", "diagnostics", "graph", "digest"]);

/**
 * Health: doc count, freshness, lifecycle, folder/type breakdown.
 */
export function handleStatusHealth(trail?: TrailConfig | null): Record<string, unknown> | null {
  const stats = getStats(VAULT_PATH);
  if (!stats) return null;

  const result: Record<string, unknown> = {
    total_notes: stats.vault.total_notes,
    vault_path: VAULT_PATH,
    by_folder: stats.vault.by_folder,
    by_type: stats.vault.by_type,
    frontmatter_completeness: stats.vault.frontmatter_completeness,
    freshness: stats.freshness,
    lifecycle: stats.lifecycle,
    computed_at: stats.computed_at,
  };

  if (trail) {
    result.trail_note = "stats are vault-wide; use list_notes for trail-scoped counts";
  }

  return result;
}

/**
 * History: recent git log, optionally filtered by since/path_prefix.
 */
export async function handleStatusHistory(
  since?: string,
  pathPrefix?: string,
): Promise<{ entries: unknown[] }> {
  const entries = await gitLog(VAULT_PATH, {
    since: since ?? "1 week ago",
    pathPrefix: pathPrefix ?? undefined,
  });
  return { entries: entries.slice(0, 30) };
}

/**
 * Diagnostics: orphan notes, broken links, missing frontmatter, stale inbox.
 */
export function handleStatusDiagnostics(): Record<string, unknown> {
  const notes = listNotes(VAULT_PATH, "*", { includeAliases: true });

  const issues = {
    orphans: [] as string[],
    broken_links: [] as string[],
    missing_frontmatter: [] as string[],
    stale_inbox: [] as string[],
  };

  // Build link graph
  const incomingLinks = new Map<string, number>();
  for (const note of notes) incomingLinks.set(note.path, 0);

  for (const note of notes) {
    const abs = join(VAULT_PATH, note.path);
    let raw: string;
    try { raw = readNoteFile(abs); } catch { continue; }

    const links = [...raw.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1]);
    for (const link of links) {
      const target = link.toLowerCase();
      const found = notes.find(
        (n) => n.name.toLowerCase() === target || n.aliases?.some((a: string) => a.toLowerCase() === target),
      );
      if (found) {
        incomingLinks.set(found.path, (incomingLinks.get(found.path) ?? 0) + 1);
      } else {
        issues.broken_links.push(`${note.path}: [[${link}]]`);
      }
    }

    if (note.path.startsWith("Resources/") && !note.type) {
      issues.missing_frontmatter.push(note.path);
    }
  }

  // Orphans: Resource notes with zero incoming links
  for (const note of notes) {
    if (note.path.startsWith("Resources/") && (incomingLinks.get(note.path) ?? 0) === 0) {
      issues.orphans.push(note.path);
    }
  }

  // Stale inbox: files older than 7 days
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const note of notes) {
    if (note.path.startsWith("Inbox/") && new Date(note.modified_at).getTime() < sevenDaysAgo) {
      issues.stale_inbox.push(note.path);
    }
  }

  return {
    total_notes: notes.length,
    orphans: { count: issues.orphans.length, notes: issues.orphans.slice(0, 20) },
    broken_links: { count: issues.broken_links.length, links: issues.broken_links.slice(0, 20) },
    missing_frontmatter: { count: issues.missing_frontmatter.length, notes: issues.missing_frontmatter.slice(0, 20) },
    stale_inbox: { count: issues.stale_inbox.length, notes: issues.stale_inbox },
  };
}

/**
 * Graph: wikilink graph analysis — most connected, bridges, clusters, orphans.
 */
export async function handleStatusGraph(): Promise<Record<string, unknown>> {
  const stats = getStats(VAULT_PATH);
  if (stats) return stats.graph as unknown as Record<string, unknown>;
  return await analyzeGraph(VAULT_PATH) as unknown as Record<string, unknown>;
}

/**
 * Digest: garden lifecycle — seeds, sprouts, growing, mature, dormant, withering.
 */
export async function handleStatusDigest(): Promise<Record<string, unknown>> {
  return await computeDigest(VAULT_PATH) as unknown as Record<string, unknown>;
}

// ── Write ──────────────────────────────────────────────────────────

export interface WriteNoteResult {
  path: string;
  action: string;
  content_hash: string;
  commit: string;
  url: string;
}

/**
 * Create or update a note with validated frontmatter.
 * Serializes through the write queue, commits to git, reindexes, and re-embeds.
 *
 * Throws on validation errors (caller should catch and return 400).
 * Returns a conflict object on hash mismatch (caller should return 409).
 */
export async function handleWriteNote(
  notePath: string,
  frontmatter: Record<string, unknown>,
  content: string,
  options: { ifHash?: string; trail?: TrailConfig | null; keyName?: string },
): Promise<WriteNoteResult> {
  // Trail write scope check
  if (options.trail) {
    if (!trailAllowsWrite(options.trail, notePath)) {
      throw Object.assign(new Error("Write not allowed: path outside trail scope"), { code: "TRAIL_DENIED" });
    }
  }

  // Validate path
  let absPath: string;
  try {
    absPath = validatePath(VAULT_PATH, notePath);
  } catch (err: any) {
    throw Object.assign(new Error(`Path error: ${err.message}`), { code: "VALIDATION", errors: [err.message] });
  }
  const relPath = relative(VAULT_PATH, absPath);

  // Validate note structure (config drives type_paths + tag rules + journal pattern)
  const { errors } = validateNote(relPath, frontmatter, content, loadVaultConfig(VAULT_PATH));
  if (errors.length > 0) {
    throw Object.assign(new Error(`Validation errors:\n${errors.map((e) => `- ${e}`).join("\n")}`), { code: "VALIDATION", errors });
  }

  // Optimistic concurrency check (hash is over plaintext, not ciphertext)
  if (options.ifHash && existsSync(absPath)) {
    const currentRaw = readNoteFile(absPath);
    const currentHash = contentHash(currentRaw);
    if (currentHash !== options.ifHash) {
      throw Object.assign(new Error("Conflict: note was modified"), { code: "CONFLICT", currentHash });
    }
  }

  // Enqueue the write
  const result = await writeQueue.enqueue(async () => {
    const serialized = serializeNote(frontmatter, content);
    const dir = dirname(absPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeNoteFile(absPath, serialized);
    invalidateFrontmatterCache(absPath);

    const isNew = !options.ifHash;
    const action = isNew ? "create" : "update";
    const who = options.keyName ? `grove (${options.keyName})` : "grove (api)";
    const commitMsg = `${who}: ${action} ${relPath}`;
    const sha = await gitCommit(VAULT_PATH, relPath, commitMsg);
    await qmdReindex(relPath);

    // Refresh stats cache (fire-and-forget)
    refreshStats(VAULT_PATH).catch(() => {});

    return {
      path: relPath,
      action,
      content_hash: contentHash(serialized),
      commit: sha,
      url: noteUrl(relPath),
    };
  });

  // Enqueue for discovery processing
  try {
    enqueueDiscovery(result.path, "write");
  } catch (err) {
    console.error(`[grove] discovery enqueue failed for ${result.path}:`, (err as Error).message);
  }

  // Fire-and-forget: re-embed the changed file
  embedFile(VAULT_PATH, result.path).catch((err) =>
    console.error(`[grove] embed-single failed for ${result.path}:`, err.message),
  );

  return result;
}

// ── Image upload ───────────────────────────────────────────────────

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_NOTE_PREFIX = "Resources/Images/";

export interface ImageUploadInput {
  file: Buffer;
  contentType: string;
  filename?: string;
  path?: string;
  tags?: string[];
}

export interface ImageUploadResult {
  image_url: string;
  thumbnail_url: string;
  note_path: string;
  content_hash: string;
  auto_tags: string[];
  description: string;
  ocr_text: string;
  dimensions: { width: number; height: number };
  url: string;
}

/** Read image dimensions from header bytes. Returns {0,0} if unrecognized. */
export function readImageDimensions(data: Buffer, contentType: string): { width: number; height: number } {
  try {
    if (contentType === "image/png" && data.length >= 24) {
      // PNG IHDR: width at offset 16, height at offset 20 (big-endian u32)
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    }
    if ((contentType === "image/jpeg" || contentType === "image/jpg") && data.length > 4) {
      // Scan JPEG SOF markers
      let i = 2;
      while (i < data.length) {
        if (data[i] !== 0xff) break;
        const marker = data[i + 1];
        const segLen = data.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = data.readUInt16BE(i + 5);
          const width = data.readUInt16BE(i + 7);
          return { width, height };
        }
        i += 2 + segLen;
      }
    }
    if (contentType === "image/gif" && data.length >= 10) {
      return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    }
    if (contentType === "image/webp" && data.length >= 30) {
      // VP8L chunk: bits at offset 21; VP8X at offset 24. Handle VP8 (lossy) simple form.
      const chunk = data.slice(12, 16).toString("ascii");
      if (chunk === "VP8 ") {
        return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === "VP8L") {
        const b0 = data[21], b1 = data[22], b2 = data[23], b3 = data[24];
        const width = 1 + (((b1 & 0x3f) << 8) | b0);
        const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        return { width, height };
      }
      if (chunk === "VP8X") {
        const width = 1 + (data[24] | (data[25] << 8) | (data[26] << 16));
        const height = 1 + (data[27] | (data[28] << 8) | (data[29] << 16));
        return { width, height };
      }
    }
  } catch {
    // fall through to unknown
  }
  return { width: 0, height: 0 };
}

/** Derive a kebab-case slug from the first few words of the description. */
export function slugFromDescription(description: string, hash: string): string {
  const trimmed = description
    .toLowerCase()
    .split(/\s+/)
    .slice(0, 6)
    .join(" ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (trimmed.length >= 3) return trimmed;
  return `image-${hash.slice(0, 12)}`;
}

type VaultIdResolver = () => string;
let vaultIdResolver: VaultIdResolver = () => process.env.GROVE_VAULT_ID ?? "life";

/** Override vault-id resolution (tests). */
export function setVaultIdResolver(fn: VaultIdResolver): void {
  vaultIdResolver = fn;
}

type AutoTagFn = (data: Buffer, contentType: string) => Promise<ImageTagResult>;
let autoTagFn: AutoTagFn = autoTagImage;

/** Override auto-tag fn (tests). */
export function setAutoTagFn(fn: AutoTagFn): void {
  autoTagFn = fn;
}

type ImageStoreResolver = () => ImageStore;
let imageStoreResolver: ImageStoreResolver = () => getImageStore();

/** Override image-store resolver (tests). */
export function setImageStoreResolver(fn: ImageStoreResolver): void {
  imageStoreResolver = fn;
}

/**
 * Upload an image: stores bytes in R2, auto-tags via Claude Vision, and
 * creates a companion vault note. Throws on validation failures, trail denies,
 * or store errors.
 */
export async function handleImageUpload(
  input: ImageUploadInput,
  options: { trail?: TrailConfig | null; keyName?: string } = {},
): Promise<ImageUploadResult> {
  // Validate size
  if (input.file.length === 0) {
    throw Object.assign(new Error("empty file"), { code: "VALIDATION" });
  }
  if (input.file.length > IMAGE_MAX_BYTES) {
    throw Object.assign(new Error("image exceeds 10MB limit"), { code: "PAYLOAD_TOO_LARGE" });
  }

  // Validate content type → extension
  const ext = extForContentType(input.contentType);
  if (!ext) {
    throw Object.assign(new Error(`unsupported content type: ${input.contentType}`), { code: "VALIDATION" });
  }

  // Compute content-addressed key
  const vaultId = vaultIdResolver();
  const key = contentKey(vaultId, input.file, ext);
  const hash = key.split("/").pop()!.replace(/\.[^.]+$/, "");

  // Upload to R2
  const store = imageStoreResolver();
  const uploaded = await store.upload(key, input.file, input.contentType);

  // Thumbnail: TODO integrate sharp for real resize — for now reuse the original URL.
  // The thumbnail_url key is still distinct so we can swap in a resized upload later.
  const thumbnailUrl = store.getUrl(key);

  // Auto-tag via Claude Vision
  const tagResult = await autoTagFn(input.file, input.contentType);

  // Merge user-supplied tags with auto-detected
  const autoTags = Array.from(
    new Set([...tagResult.tags, ...(input.tags ?? [])].map((t) => t.trim()).filter(Boolean)),
  );

  // Determine note path
  const slug = slugFromDescription(tagResult.description || input.filename || "", hash);
  const notePath = input.path ?? `${IMAGE_NOTE_PREFIX}${slug}.md`;

  // Enforce trail-scoped writes
  if (options.trail && !trailAllowsWrite(options.trail, notePath)) {
    throw Object.assign(new Error("Write not allowed: path outside trail scope"), { code: "TRAIL_DENIED" });
  }

  // Build companion note
  const dimensions = readImageDimensions(input.file, input.contentType);
  const title = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const frontmatter: Record<string, unknown> = {
    type: "image",
    tags: autoTags.length > 0 ? autoTags : ["image"],
    image_url: uploaded.url,
    thumbnail_url: thumbnailUrl,
    content_hash: hash,
    dimensions,
    uploaded_at: new Date().toISOString(),
  };
  if (tagResult.ocr_text) frontmatter.ocr_text = tagResult.ocr_text;

  const description = tagResult.description || `Image uploaded ${new Date().toISOString().slice(0, 10)}.`;
  const content = `# ${title}\n\n${description}\n\n![${title}](${uploaded.url})\n`;

  // Create the note via the existing write pipeline (validates + commits + reindexes + embeds)
  const noteResult = await handleWriteNote(notePath, frontmatter, content, {
    trail: options.trail,
    keyName: options.keyName,
  });

  return {
    image_url: uploaded.url,
    thumbnail_url: thumbnailUrl,
    note_path: noteResult.path,
    content_hash: hash,
    auto_tags: autoTags,
    description,
    ocr_text: tagResult.ocr_text,
    dimensions,
    url: noteResult.url,
  };
}
