#!/usr/bin/env tsx
/**
 * Grove MCP Server — registers 6 tools for the knowledge API.
 *
 * Tools: query, get, multi_get, write_note, list_notes, vault_status
 * Proxy forwards authenticated MCP requests here.
 *
 * Usage:
 *   GROVE_VAULT=/path/to/vault GROVE_SERVER_PORT=8190 npx tsx src/server.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { hybridSearch, formatResults, bm25Search } from "./hybrid-search.js";

/** Encode a vault path as a valid URL (encode each segment, preserve slashes) */
function noteUrl(vaultPath: string): string {
  const stripped = vaultPath.replace(/\.md$/, "");
  const encoded = stripped.split("/").map(encodeURIComponent).join("/");
  return `https://grove.md/${encoded}`;
}

import { gitLog, startupRecovery, listNotes } from "./vault-ops.js";
import { parseNote, contentHash } from "./notes-validate.js";
import { handleWriteNote, flushWriteQueue } from "./rest.js";
import { analyzeGraph, computeDigest } from "./vault-graph.js";
import { getStats, startStatsTimer } from "./vault-stats.js";
import { RateLimiter, IdempotencyCache } from "./rate-limit.js";
import { log as structuredLog, auditRead } from "./logger.js";
import { filterByTrail, logTrailAccess, type TrailConfig, type NoteMetadata } from "./trails.js";
import { runMigration } from "./db.js";

// ── Path traversal guard ─────────────────────────────────────────
// Resolves a relative path against the vault and rejects any attempt
// to escape outside the vault via ".." or symlinks.
function sanitizePath(vaultRoot: string, filePath: string): string | null {
  const root = resolve(vaultRoot);
  const normalized = resolve(root, filePath);
  if (!normalized.startsWith(root + "/") && normalized !== root) return null;
  if (filePath.includes("..")) return null;
  try {
    const stat = lstatSync(normalized);
    if (stat.isSymbolicLink()) return null;
  } catch {
    // File doesn't exist yet — that's fine for reads (will get "not found")
  }
  return normalized;
}

const VAULT_PATH = process.env.GROVE_VAULT ?? join(homedir(), "life");
const PORT = Number(process.env.GROVE_SERVER_PORT ?? 8190);

const rateLimiter = new RateLimiter({ reads: 120, writes: 20, windowMs: 60_000 });
const idempotencyCache = new IdempotencyCache(1000, 3_600_000);

// ── Server instructions (what Claude.ai sees) ─────────────────────

const INSTRUCTIONS = `Grove is your knowledge API over a personal Obsidian vault (~1000 notes).

Vault structure:
  Journal/YYYY/       — daily entries (type: journal)
  Resources/Concepts/ — ideas, frameworks (type: concept)
  Resources/People/   — people (type: person)
  Resources/Recipes/  — recipes (type: recipe)
  Resources/Projects/ — projects (type: project)
  Resources/Companies/— companies (type: company)
  Resources/Places/   — places (type: place)
  Areas/              — ongoing life domains (Health, Finances, Business, Meal Planning)
  Inbox/              — unsorted captures
  Sources/            — external content archive
  Notes/              — working scratchpad

Linking: Use [[wikilinks]] aggressively. Pipe for readability: [[Full Name|display text]].
Red links (to notes that don't exist yet) are fine — they're a backlog.

Searching: Use query with lex (keyword) and vec (semantic) sub-queries. Provide intent for better snippets.

Writing: Use write_note with proper frontmatter (type + tags required). Use if_hash for safe updates to existing notes.

URLs: Every tool response includes a url field. ALWAYS show it to the user as a clickable link — especially after writes. This is the primary way the user accesses their notes.`;

// ── Create MCP server with all 6 tools ────────────────────────────

function createGroveServer(): McpServer {
  // Trail capabilities in initialize handshake — serverInfo includes trail context
  const trailInitialize = activeTrail
    ? `\n\nThis connection is scoped to trail "${activeTrail.name}" (${activeTrail.id}). Only notes matching the trail's topic boundaries are visible.`
    : "";
  const serverInfo = activeTrail ? { name: "grove", version: "1.0.0", trail: { id: activeTrail.id, name: activeTrail.name } } : { name: "grove", version: "1.0.0" };
  const server = new McpServer(
    serverInfo as { name: string; version: string },
    { instructions: INSTRUCTIONS + trailInitialize },
  );

  // ── Tool 1: query ───────────────────────────────────────────────
  server.registerTool(
    "query",
    {
      title: "Search notes",
      description: `Search notes by keyword or meaning. Returns ranked results with snippets.

Sub-query types:
  lex — BM25 keyword search (exact terms, fast)
  vec — semantic vector search (meaning-based)

Always provide intent to disambiguate. Combine lex + vec for best results.
Example: searches=[{type:'lex', query:'salary'}, {type:'vec', query:'how much do I make'}], intent='compensation details'`,
      inputSchema: {
        searches: z.array(z.object({
          type: z.enum(["lex", "vec", "hyde"]),
          query: z.string(),
        })).describe("Search sub-queries"),
        intent: z.string().optional().describe("What you're looking for — improves snippet selection"),
        limit: z.number().optional().default(10).describe("Max results"),
      },
    },
    async ({ searches, limit }) => {
      const queryText = searches.map((s) => s.query).join(" ");
      // Fetch more results if trail filtering is active (pre-filter reduction)
      const fetchLimit = activeTrail ? (limit ?? 10) * 3 : (limit ?? 10);
      const results = await hybridSearch(queryText, fetchLimit);
      const totalFound = results.length;

      // Resolve QMD lowercase-kebab paths to real filesystem paths.
      // QMD index stores e.g. "resources/concepts/meditation-mindfulness.md"
      // but the filesystem has "Resources/Concepts/Meditation & Mindfulness.md".
      const allNotes = listNotes(VAULT_PATH, "*");
      const resolveRealPath = (vaultPath: string, title: string): string => {
        const vp = vaultPath.toLowerCase();
        const note = allNotes.find((n: { path: string; name: string }) => n.path.toLowerCase() === vp || n.name === title);
        return note?.path ?? vaultPath;
      };

      // Trail prefilter
      let filtered = results;
      if (activeTrail) {
        filtered = results.filter((r) => {
          const vp = r.vault_path.toLowerCase();
          const note = allNotes.find((n: { path: string; name: string }) => n.path.toLowerCase() === vp || n.name === r.title);
          if (!note) return false;
          const absPath = join(VAULT_PATH, note.path);
          try {
            const raw = readFileSync(absPath, "utf-8");
            const { frontmatter } = parseNote(raw);
            const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags as string[] :
              typeof frontmatter.tags === "string" ? [frontmatter.tags] : [];
            const meta: NoteMetadata = { path: note.path, type: frontmatter.type as string, tags, private: frontmatter.private === true };
            return filterByTrail(activeTrail!, meta);
          } catch {
            return filterByTrail(activeTrail!, { path: note.path });
          }
        }).slice(0, limit ?? 10);
        logTrailAccess("query", activeTrail.id, activeTrail.name, "query", totalFound, filtered.length);
      }

      const formatted = formatResults(filtered, resolveRealPath);
      const filteredCount = activeTrail ? `\n\n[filtered_count: ${filtered.length}/${totalFound}]` : "";
      return { content: [{ type: "text" as const, text: (formatted || "No results found.") + filteredCount }] };
    },
  );

  // ── Tool 2: get ─────────────────────────────────────────────────
  server.registerTool(
    "get",
    {
      title: "Read a note",
      description: `Read a note by path. Returns frontmatter + content + content_hash.

Paths are relative to vault root: "Resources/Concepts/Taste Graph.md"
If not found, tries fuzzy matching by title via search.
Use the content_hash as if_hash when updating the note.`,
      inputSchema: {
        file: z.string().describe("File path relative to vault root, or note title"),
      },
    },
    async ({ file }) => {
      // Helper: read and return a note given absolute + relative paths
      const readNote = (abs: string, rel: string, resolvedFrom?: string) => {
        const raw = readFileSync(abs, "utf-8");
        const { frontmatter, content } = parseNote(raw);

        // Trail filter: if note not visible under trail, return 404 (not 403 — don't leak existence)
        if (activeTrail) {
          const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags as string[] :
            typeof frontmatter.tags === "string" ? [frontmatter.tags] : [];
          const meta: NoteMetadata = { path: rel, type: frontmatter.type as string, tags, private: frontmatter.private === true };
          if (!filterByTrail(activeTrail, meta)) {
            return { content: [{ type: "text" as const, text: `Note not found: ${file}` }] };
          }
        }

        const hash = contentHash(raw);
        const url = noteUrl(rel);
        const result: Record<string, unknown> = { path: rel, url, frontmatter, content, content_hash: hash };
        if (resolvedFrom) result.resolved_from = resolvedFrom;
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      };

      // 1. Normalize the input path — strip common prefixes
      let filePath = file.replace(/^(life\/|qmd:\/\/life\/)/, "");
      if (!filePath.endsWith(".md")) filePath += ".md";

      // 2. Try direct read at the given path (with traversal guard)
      const abs = sanitizePath(VAULT_PATH, filePath);
      if (!abs) return { content: [{ type: "text" as const, text: `Path rejected: traversal outside vault not allowed` }] };
      if (existsSync(abs)) return readNote(abs, filePath);

      // 3. Extract the basename for searching (e.g., "Taste Graph" from "Resources/Concepts/Taste Graph.md")
      const searchTerm = filePath.replace(/\.md$/, "").split("/").pop() ?? file;

      // 4. For date-like basenames (YYYY-MM-DD), try Journal paths directly
      const dateMatch = searchTerm.match(/^(\d{4})-\d{2}-\d{2}$/);
      if (dateMatch) {
        const year = dateMatch[1];
        // Try current year folder and the year from the date
        for (const y of [year, String(new Date().getFullYear())]) {
          const journalPath = `Journal/${y}/${searchTerm}.md`;
          const journalAbs = join(VAULT_PATH, journalPath);
          if (existsSync(journalAbs)) return readNote(journalAbs, journalPath, file);
        }
      }

      // 5. Case-insensitive basename search across the entire vault
      const searchLower = searchTerm.toLowerCase();
      const allNotes = listNotes(VAULT_PATH, "*");
      const nameMatch = allNotes.find((n) => n.name.toLowerCase() === searchLower);
      if (nameMatch) {
        const matchAbs = join(VAULT_PATH, nameMatch.path);
        if (existsSync(matchAbs)) return readNote(matchAbs, nameMatch.path, file);
      }

      // 6. Also check aliases
      const aliasNotes = listNotes(VAULT_PATH, "*", { includeAliases: true });
      const aliasMatch = aliasNotes.find(
        (n) => n.aliases?.some((a) => a.toLowerCase() === searchLower),
      );
      if (aliasMatch) {
        const matchAbs = join(VAULT_PATH, aliasMatch.path);
        if (existsSync(matchAbs)) return readNote(matchAbs, aliasMatch.path, file);
      }

      // 7. Fall back to BM25 search for partial/fuzzy matches
      try {
        const results = await bm25Search(searchTerm, 3);
        if (results.length > 0) {
          // The vault_path from QMD may be lowercased; find the real path via listNotes
          const resolvedLower = results[0].vault_path.toLowerCase();
          const realNote = allNotes.find((n) => n.path.toLowerCase() === resolvedLower);
          const realPath = realNote?.path ?? results[0].vault_path;
          const resolvedAbs = join(VAULT_PATH, realPath);
          if (existsSync(resolvedAbs)) return readNote(resolvedAbs, realPath, file);
        }
      } catch {
        // BM25 search unavailable or errored — fall through to "not found"
      }

      return { content: [{ type: "text" as const, text: `Note not found: ${file}` }] };
    },
  );

  // ── Tool 3: multi_get ───────────────────────────────────────────
  server.registerTool(
    "multi_get",
    {
      title: "Batch read notes",
      description: `Read multiple notes at once. Accepts a glob pattern or comma-separated paths.
Examples: "Resources/People/*.md", "Journal/2026/*.md", "path1.md,path2.md"`,
      inputSchema: {
        pattern: z.string().describe("Glob pattern or comma-separated file paths"),
      },
    },
    async ({ pattern }) => {
      let entries: { path: string; name: string }[];
      if (pattern.includes(",")) {
        entries = pattern.split(",").map((p) => ({ path: p.trim(), name: p.trim().split("/").pop()?.replace(".md", "") ?? p }));
      } else {
        entries = listNotes(VAULT_PATH, pattern);
      }
      const results: Record<string, unknown>[] = [];
      for (const entry of entries.slice(0, 50)) {
        const abs = sanitizePath(VAULT_PATH, entry.path);
        if (!abs) {
          results.push({ path: entry.path, error: "path traversal outside vault not allowed" });
          continue;
        }
        if (!existsSync(abs)) {
          results.push({ path: entry.path, error: "not found" });
          continue;
        }
        const raw = readFileSync(abs, "utf-8");
        const { frontmatter, content } = parseNote(raw);
        // Trail filter: hidden notes return 404 (not 403)
        if (activeTrail) {
          const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags as string[] :
            typeof frontmatter.tags === "string" ? [frontmatter.tags] : [];
          const meta: NoteMetadata = { path: entry.path, type: frontmatter.type as string, tags, private: frontmatter.private === true };
          if (!filterByTrail(activeTrail, meta)) {
            results.push({ path: entry.path, error: "not found" });
            continue;
          }
        }
        const url = noteUrl(entry.path);
        results.push({ path: entry.path, url, frontmatter, content, content_hash: contentHash(raw) });
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    },
  );

  // ── Tool 4: write_note ──────────────────────────────────────────
  server.registerTool(
    "write_note",
    {
      title: "Create or update a note",
      description: `Create or update a note with validated frontmatter.

STRUCTURE — common paths (but any path works):
  Resources/Concepts/Name.md   Resources/People/Name.md
  Resources/Recipes/Name.md    Resources/Projects/Name.md
  Sources/Name.md              Journal/YYYY/YYYY-MM-DD.md
  Areas/Name.md                Inbox/Name.md
  Notes/Name.md

FILENAMES — use kebab-case (hyphens, lowercase) for clean URLs:
  Resources/Concepts/gentle-oxiclean-alternatives.md  ✓
  Resources/Concepts/Gentle OxiClean Alternatives.md  ✗
  Resources/People/John-Milinovich.md                 ✓
Use aliases in frontmatter for the human-readable title.

Only constraint: don't put a type in another type's designated folder
(e.g., don't put type: person in Resources/Concepts/).

FRONTMATTER — needs type (any string) + at least one tag:
  type: concept          — any string works, not just known types
  tags: [ai, research]   — at least one tag, your choice what
  aliases: ["Display Name"] — the human-readable title (required since filenames are kebab-case)

Special requirements:
  journal needs: date    recipe needs: meal_type

LINKING — use [[wikilinks]] aggressively. Pipe for readability: [[Full Name|display text]].

RESOURCE NOTES should include a dataview backlink query:
  \`\`\`dataview
  LIST FROM "Journal" WHERE contains(file.outlinks, this.file.link) SORT date DESC
  \`\`\`

SAFE UPDATES — pass if_hash (from a prior get) to prevent overwriting concurrent changes. Omit for new notes.

After writing, present the url field from the response to the user.`,
      inputSchema: {
        path: z.string().describe("File path relative to vault root, kebab-case (e.g., 'Resources/Concepts/context-engineering.md')"),
        frontmatter: z.string().describe("YAML frontmatter as JSON string (e.g., '{\"type\":\"concept\",\"tags\":[\"concept\"]}')"),
        content: z.string().describe("Note body (markdown)"),
        if_hash: z.string().optional().describe("Content hash from prior read — rejects if file changed since"),
      },
    },
    async ({ path: notePath, frontmatter: fmInput, content, if_hash }) => {
      // Parse frontmatter from JSON string
      let frontmatter: Record<string, unknown>;
      try {
        frontmatter = typeof fmInput === "string" ? JSON.parse(fmInput) : fmInput;
      } catch {
        return { content: [{ type: "text" as const, text: "Invalid frontmatter JSON" }], isError: true };
      }

      try {
        const result = await handleWriteNote(notePath, frontmatter, content, {
          ifHash: if_hash,
          trail: activeTrail,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: err.message }], isError: true };
      }
    },
  );

  // ── Tool 5: list_notes ──────────────────────────────────────────
  server.registerTool(
    "list_notes",
    {
      title: "List notes in a folder",
      description: `List notes matching a pattern. Returns path, name, type, and modified date.
Use for:
  - Check if a note exists before creating (avoid duplicates)
  - Get all entity names + aliases: list_notes("Resources/People/*", include_aliases=true)
  - Browse a folder: list_notes("Journal/2026/*")
  - Find Inbox items: list_notes("Inbox/*")`,
      inputSchema: {
        pattern: z.string().describe("Glob pattern (e.g., 'Resources/People/*', 'Journal/2026/*')"),
        include_aliases: z.boolean().optional().default(false).describe("Include frontmatter aliases (for entity matching)"),
      },
    },
    async ({ pattern, include_aliases }) => {
      let entries = listNotes(VAULT_PATH, pattern, { includeAliases: include_aliases ?? false });
      // Trail filter: only return trail-visible notes in list
      if (activeTrail) {
        const totalCount = entries.length;
        entries = entries.filter((e) => {
          const meta: NoteMetadata = { path: e.path, type: e.type ?? undefined, tags: e.tags, private: e.private };
          return filterByTrail(activeTrail!, meta);
        });
        logTrailAccess("list", activeTrail.id, activeTrail.name, "list_notes", totalCount, entries.length);
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ count: entries.length, notes: entries }, null, 2) }],
      };
    },
  );

  // ── Tool 6: vault_status ────────────────────────────────────────
  server.registerTool(
    "vault_status",
    {
      title: "Vault health and diagnostics",
      description: `Vault health, recent changes, and diagnostics.

Modes:
  health       — doc count, last commit date
  history      — recent git log (filter by since, path_prefix)
  diagnostics  — orphan notes, broken [[links]], missing frontmatter, stale Inbox items
  graph        — wikilink graph: most connected, bridges, clusters, orphans
  digest       — garden lifecycle: seeds, sprouts, growing, mature, dormant, withering`,
      inputSchema: {
        mode: z.enum(["health", "history", "diagnostics", "graph", "digest"]).describe("What to check"),
        since: z.string().optional().describe("For history: date filter (e.g., '1 week ago', '2026-04-01')"),
        path_prefix: z.string().optional().describe("For history: path filter (e.g., 'Journal/')"),
      },
    },
    async ({ mode, since, path_prefix }) => {
      if (mode === "health") {
        const stats = getStats(VAULT_PATH);
        if (stats) {
          const statusResult: Record<string, unknown> = {
            total_notes: stats.vault.total_notes,
            vault_path: VAULT_PATH,
            by_folder: stats.vault.by_folder,
            by_type: stats.vault.by_type,
            frontmatter_completeness: stats.vault.frontmatter_completeness,
            freshness: stats.freshness,
            lifecycle: stats.lifecycle,
            computed_at: stats.computed_at,
          };
          // Trail: add scoped note to indicate these are vault-wide stats
          if (activeTrail) {
            statusResult.trail_note = "stats are vault-wide; use list_notes for trail-scoped counts";
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify(statusResult, null, 2) }],
          };
        }
        // Fallback: stats not yet computed, do the old way
        const notes = listNotes(VAULT_PATH, "*");
        const log = await gitLog(VAULT_PATH, { limit: 1 });
        const lastCommit = log[0] ?? null;
        let totalNotes = notes.length;
        const statusResult: Record<string, unknown> = {
          total_notes: totalNotes,
          last_commit: lastCommit ? { date: lastCommit.date, message: lastCommit.message } : null,
          vault_path: VAULT_PATH,
        };
        if (activeTrail) {
          const visibleNotes = notes.filter((n) => {
            const meta: NoteMetadata = { path: n.path, type: n.type ?? undefined, tags: n.tags, private: n.private };
            return filterByTrail(activeTrail!, meta);
          });
          statusResult.total_notes = visibleNotes.length;
          statusResult.scoped_stats = { trail_id: activeTrail.id, trail_name: activeTrail.name, total_in_vault: totalNotes, visible: visibleNotes.length };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(statusResult, null, 2) }],
        };
      }

      if (mode === "history") {
        const entries = await gitLog(VAULT_PATH, {
          since: since ?? "1 week ago",
          pathPrefix: path_prefix,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ entries: entries.slice(0, 30) }, null, 2) }],
        };
      }

      if (mode === "diagnostics") {
        return await runDiagnostics();
      }

      if (mode === "graph") {
        const stats = getStats(VAULT_PATH);
        if (stats) {
          return { content: [{ type: "text" as const, text: JSON.stringify(stats.graph, null, 2) }] };
        }
        // Fallback: compute directly
        const graph = await analyzeGraph(VAULT_PATH);
        return { content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }] };
      }

      if (mode === "digest") {
        const digest = await computeDigest(VAULT_PATH);
        return { content: [{ type: "text" as const, text: JSON.stringify(digest, null, 2) }] };
      }

      return { content: [{ type: "text" as const, text: "Unknown mode" }] };
    },
  );

  // ── Resource: vault notes accessible as MCP resources ──────────
  server.resource(
    "note",
    new ResourceTemplate("vault://life/{path}", { list: undefined }),
    async (uri, { path }) => ({
      contents: [{
        uri: uri.href,
        mimeType: "text/markdown",
        text: readFileSync(join(VAULT_PATH, path as string), "utf-8"),
      }],
    }),
  );

  return server;
}

// ── Diagnostics: orphans, broken links, missing frontmatter ───────

async function runDiagnostics() {
  const notes = listNotes(VAULT_PATH, "*", { includeAliases: true });
  const noteNames = new Set(notes.map((n) => n.name.toLowerCase()));
  const notePaths = new Set(notes.map((n) => n.path));

  const issues: { orphans: string[]; broken_links: string[]; missing_frontmatter: string[]; stale_inbox: string[] } = {
    orphans: [],
    broken_links: [],
    missing_frontmatter: [],
    stale_inbox: [],
  };

  // Build link graph
  const incomingLinks = new Map<string, number>();
  for (const note of notes) incomingLinks.set(note.path, 0);

  for (const note of notes) {
    const abs = join(VAULT_PATH, note.path);
    let raw: string;
    try { raw = readFileSync(abs, "utf-8"); } catch {
      // File may have been deleted between listing and reading — skip
      continue;
    }

    // Extract wikilinks
    const links = [...raw.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1]);
    for (const link of links) {
      const target = link.toLowerCase();
      // Check if target exists
      const found = notes.find((n) => n.name.toLowerCase() === target || n.aliases?.some((a) => a.toLowerCase() === target));
      if (found) {
        incomingLinks.set(found.path, (incomingLinks.get(found.path) ?? 0) + 1);
      } else {
        issues.broken_links.push(`${note.path}: [[${link}]]`);
      }
    }

    // Missing frontmatter (Resource notes only)
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
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        total_notes: notes.length,
        orphans: { count: issues.orphans.length, notes: issues.orphans.slice(0, 20) },
        broken_links: { count: issues.broken_links.length, links: issues.broken_links.slice(0, 20) },
        missing_frontmatter: { count: issues.missing_frontmatter.length, notes: issues.missing_frontmatter.slice(0, 20) },
        stale_inbox: { count: issues.stale_inbox.length, notes: issues.stale_inbox },
      }, null, 2),
    }],
  };
}

// ── HTTP server with session management ───────────────────────────

const sessions = new Map<string, StreamableHTTPServerTransport>();
const sessionTrails = new Map<string, TrailConfig>(); // trail config per session
let activeTrail: TrailConfig | null = null; // current request's trail (set before tool execution)

async function createSession(): Promise<StreamableHTTPServerTransport> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, transport);
      console.log(`[grove] session ${sessionId} (${sessions.size} active)`);
    },
  });
  const server = createGroveServer();
  await server.connect(transport);
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  return transport;
}

const MAX_BODY = 1048576; // 1MB body size limit

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

const httpServer = createServer(async (req, res) => {
  // Read audit: log every request with correlation ID from proxy
  const requestId = req.headers["x-request-id"] as string | undefined;
  if (requestId) {
    auditRead(requestId, "server", "grove-server", req.method ?? "GET", { url: req.url });
  }

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, x-request-id");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Health
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, server: "grove" }));
    return;
  }

  // MCP endpoint
  if (req.url === "/" || req.url === "/mcp") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Set active trail from proxy headers (trail resolution happens per-request)
    const trailConfigHeader = req.headers["x-trail-config"] as string | undefined;
    if (trailConfigHeader) {
      try { activeTrail = JSON.parse(trailConfigHeader); } catch { activeTrail = null; }
    } else {
      activeTrail = null;
    }

    // Store trail config per session for SSE reconnects
    if (activeTrail && sessionId) {
      sessionTrails.set(sessionId, activeTrail);
    } else if (sessionId && sessionTrails.has(sessionId)) {
      activeTrail = sessionTrails.get(sessionId)!;
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      let parsed: any;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end("Invalid JSON"); return; }

      let transport: StreamableHTTPServerTransport;

      if (sessionId && sessions.has(sessionId)) {
        transport = sessions.get(sessionId)!;
      } else if (!sessionId) {
        // New session — create transport + server
        transport = await createSession();
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid session" }));
        return;
      }

      // StreamableHTTPServerTransport.handleRequest takes Node req/res directly
      await transport.handleRequest(req, res, parsed);
      return;
    }

    if (req.method === "GET") {
      // SSE — pass to transport if session exists
      if (sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }
      res.writeHead(400);
      res.end("No session");
      return;
    }

    if (req.method === "DELETE" && sessionId) {
      sessions.delete(sessionId);
      res.writeHead(200);
      res.end();
      return;
    }
  }

  res.writeHead(404);
  res.end("Not found");
});

// ── Startup ───────────────────────────────────────────────────────

async function start() {
  console.log(`[grove] vault: ${VAULT_PATH}`);

  // Initialize SQLite database and migrate from JSON if needed
  runMigration();

  try {
    await startupRecovery(VAULT_PATH);
  } catch (err) {
    console.warn("[grove] startup recovery failed:", (err as Error).message);
  }

  // Start background stats computation (every 5 min)
  startStatsTimer(VAULT_PATH);
  console.log("[grove] stats timer started (5 min interval)");

  httpServer.listen(PORT, "127.0.0.1", () => {
    console.log(`[grove] MCP server listening on http://127.0.0.1:${PORT}`);
    console.log(`[grove] 6 tools registered: query, get, multi_get, write_note, list_notes, vault_status`);
  });
}

start().catch(console.error);

// ── Graceful shutdown ────────────────────────────────────────────
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[grove] ${signal} received, flushing write queue...`);
    await flushWriteQueue();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 15_000);
  });
}
