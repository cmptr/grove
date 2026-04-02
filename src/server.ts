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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { hybridSearch, formatResults, bm25Search } from "./hybrid-search.js";
import { WriteQueue } from "./write-queue.js";
import { gitCommit, gitPush, gitLog, startupRecovery, qmdReindex, listNotes } from "./vault-ops.js";
import { validatePath, validateNote, parseNote, serializeNote, contentHash } from "./notes-validate.js";

const VAULT_PATH = process.env.GROVE_VAULT ?? join(homedir(), "life");
const PORT = Number(process.env.GROVE_SERVER_PORT ?? 8190);

const writeQueue = new WriteQueue();
writeQueue.schedulePush(() => gitPush(VAULT_PATH));

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

Writing: Use write_note with proper frontmatter (type + tags required). Use if_hash for safe updates to existing notes.`;

// ── Create MCP server with all 6 tools ────────────────────────────

function createGroveServer(): McpServer {
  const server = new McpServer(
    { name: "grove", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
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
      const results = await hybridSearch(queryText, limit ?? 10);
      const formatted = formatResults(results);
      return { content: [{ type: "text" as const, text: formatted || "No results found." }] };
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
        const hash = contentHash(raw);
        const result: Record<string, unknown> = { path: rel, frontmatter, content, content_hash: hash };
        if (resolvedFrom) result.resolved_from = resolvedFrom;
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      };

      // 1. Normalize the input path — strip common prefixes
      let filePath = file.replace(/^(life\/|qmd:\/\/life\/)/, "");
      if (!filePath.endsWith(".md")) filePath += ".md";

      // 2. Try direct read at the given path
      const abs = join(VAULT_PATH, filePath);
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
          // Search results may have qmd:// prefix — strip it
          const resolved = results[0].file.replace(/^qmd:\/\/life\//, "");
          // The resolved path from QMD may be lowercased; find the real path via listNotes
          const resolvedLower = resolved.toLowerCase();
          const realNote = allNotes.find((n) => n.path.toLowerCase() === resolvedLower);
          const realPath = realNote?.path ?? resolved;
          const resolvedAbs = join(VAULT_PATH, realPath);
          if (existsSync(resolvedAbs)) return readNote(resolvedAbs, realPath, file);
        }
      } catch {}

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
        const abs = join(VAULT_PATH, entry.path);
        if (!existsSync(abs)) {
          results.push({ path: entry.path, error: "not found" });
          continue;
        }
        const raw = readFileSync(abs, "utf-8");
        const { frontmatter, content } = parseNote(raw);
        results.push({ path: entry.path, frontmatter, content: content.slice(0, 2000), content_hash: contentHash(raw) });
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

STRUCTURE — put notes in the right place:
  Resources/Concepts/Name.md   (type: concept)
  Resources/People/Name.md     (type: person)
  Resources/Recipes/Name.md    (type: recipe — needs meal_type, source)
  Resources/Projects/Name.md   (type: project)
  Journal/YYYY/YYYY-MM-DD.md   (type: journal — needs date, source)
  Inbox/Name.md                (any type)

FRONTMATTER — every note needs type + tags:
  type: concept
  tags: [concept]
  aliases: ["alternate name"]  (optional)

LINKING — use [[wikilinks]] aggressively. Pipe for readability: [[Full Name|display text]].

RESOURCE NOTES should include a dataview backlink query:
  \`\`\`dataview
  LIST FROM "Journal" WHERE contains(file.outlinks, this.file.link) SORT date DESC
  \`\`\`

SAFE UPDATES — pass if_hash (from a prior get) to prevent overwriting concurrent changes. Omit for new notes.`,
      inputSchema: {
        path: z.string().describe("File path relative to vault root (e.g., 'Resources/Concepts/Context Engineering.md')"),
        frontmatter: z.record(z.unknown()).describe("YAML frontmatter object (type and tags required)"),
        content: z.string().describe("Note body (markdown)"),
        if_hash: z.string().optional().describe("Content hash from prior read — rejects if file changed since"),
      },
    },
    async ({ path: notePath, frontmatter, content, if_hash }) => {
      // Validate path
      let absPath: string;
      try {
        absPath = validatePath(VAULT_PATH, notePath);
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Path error: ${err.message}` }], isError: true };
      }

      // Validate note
      const relPath = relative(VAULT_PATH, absPath);
      const { errors } = validateNote(relPath, frontmatter, content);
      if (errors.length > 0) {
        return { content: [{ type: "text" as const, text: `Validation errors:\n${errors.map((e) => `- ${e}`).join("\n")}` }], isError: true };
      }

      // Optimistic concurrency check
      if (if_hash && existsSync(absPath)) {
        const currentRaw = readFileSync(absPath, "utf-8");
        const currentHash = contentHash(currentRaw);
        if (currentHash !== if_hash) {
          return {
            content: [{ type: "text" as const, text: `Conflict: note was modified. Current hash: ${currentHash}` }],
            isError: true,
          };
        }
      }

      // Enqueue the write
      const result = await writeQueue.enqueue(async () => {
        const serialized = serializeNote(frontmatter, content);
        const dir = dirname(absPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(absPath, serialized, "utf-8");

        const isNew = !if_hash;
        const action = isNew ? "create" : "update";
        const commitMsg = `grove (api): ${action} ${relPath}`;
        const sha = await gitCommit(VAULT_PATH, relPath, commitMsg);
        await qmdReindex(relPath);

        return { path: relPath, action, content_hash: contentHash(serialized), commit: sha };
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
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
      const entries = listNotes(VAULT_PATH, pattern, { includeAliases: include_aliases ?? false });
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
  diagnostics  — orphan notes, broken [[links]], missing frontmatter, stale Inbox items`,
      inputSchema: {
        mode: z.enum(["health", "history", "diagnostics"]).describe("What to check"),
        since: z.string().optional().describe("For history: date filter (e.g., '1 week ago', '2026-04-01')"),
        path_prefix: z.string().optional().describe("For history: path filter (e.g., 'Journal/')"),
      },
    },
    async ({ mode, since, path_prefix }) => {
      if (mode === "health") {
        const notes = listNotes(VAULT_PATH, "*");
        const log = await gitLog(VAULT_PATH, { limit: 1 });
        const lastCommit = log[0] ?? null;
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            total_notes: notes.length,
            last_commit: lastCommit ? { date: lastCommit.date, message: lastCommit.message } : null,
            vault_path: VAULT_PATH,
          }, null, 2) }],
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

      return { content: [{ type: "text" as const, text: "Unknown mode" }] };
    },
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
    try { raw = readFileSync(abs, "utf-8"); } catch { continue; }

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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

const httpServer = createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
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
  try {
    await startupRecovery(VAULT_PATH);
  } catch (err) {
    console.warn("[grove] startup recovery failed:", (err as Error).message);
  }

  httpServer.listen(PORT, "127.0.0.1", () => {
    console.log(`[grove] MCP server listening on http://127.0.0.1:${PORT}`);
    console.log(`[grove] 6 tools registered: query, get, multi_get, write_note, list_notes, vault_status`);
  });
}

start().catch(console.error);
