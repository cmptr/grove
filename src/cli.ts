#!/usr/bin/env tsx
/**
 * Grove CLI — talk to the Grove MCP server from the terminal.
 *
 * Usage:
 *   grove search "taste graph"
 *   grove read "Taste Graph"
 *   grove list "Resources/People/*"
 *   grove history --since "3 days ago"
 *   grove status
 *   grove diagnostics
 *   grove write "Inbox/idea.md" --type concept
 */

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readArchiveSources, planSync, normalizeDir } from "./sync-sources.js";

// ── Config ───────────────────────────────────────────────────────

interface Config {
  server: string;
  token: string;
}

function loadConfig(): Config {
  const path = join(homedir(), ".grove", "cli.json");
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // Missing or invalid config file — can't proceed without server/token
    console.error(`Config not found: ${path}`);
    console.error(`Create it with: { "server": "https://api.grove.md", "token": "grove_live_..." }`);
    process.exit(1);
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────

let sessionId: string | undefined;

function post(url: URL, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const data = JSON.stringify(body);
  const isHttps = url.protocol === "https:";
  const doRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = doRequest(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          "Accept": "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ── MCP JSON-RPC ─────────────────────────────────────────────────

let rpcId = 0;

async function mcpRequest(config: Config, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const url = new URL("/mcp", config.server);
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${config.token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const body = { jsonrpc: "2.0", id: ++rpcId, method, params };
  const res = await post(url, body, headers);

  if (res.status === 401) {
    console.error("Authentication failed. Check your token in ~/.grove/cli.json");
    process.exit(1);
  }

  // Capture session ID from response
  const sid = res.headers["mcp-session-id"];
  if (sid) sessionId = Array.isArray(sid) ? sid[0] : sid;

  try {
    return JSON.parse(res.body);
  } catch {
    // Server returned non-JSON (likely HTML error page or empty response)
    console.error(`Unexpected response (${res.status}): ${res.body.slice(0, 200)}`);
    process.exit(1);
  }
}

async function initialize(config: Config): Promise<void> {
  await mcpRequest(config, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "grove-cli", version: "1.0.0" },
  });
}

async function callTool(config: Config, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await mcpRequest(config, "tools/call", { name, arguments: args });
  if (res.error) {
    console.error(`Error: ${res.error.message ?? JSON.stringify(res.error)}`);
    process.exit(1);
  }
  const content = res.result?.content?.[0]?.text;
  if (content == null) {
    console.error("No content in response");
    process.exit(1);
  }
  return content;
}

// ── Argument parsing ─────────────────────────────────────────────

function parseArgs(argv: string[]): { command: string; positional: string; flags: Record<string, string | boolean> } {
  const command = argv[0] ?? "help";
  let positional = "";
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (!positional) {
      positional = arg;
    }
  }

  return { command, positional, flags };
}

// ── Output formatters ────────────────────────────────────────────

function formatSearch(raw: string): string {
  // The query tool returns pre-formatted text from formatResults
  return raw;
}

function formatRead(raw: string): string {
  try {
    const data = JSON.parse(raw);
    if (data.error || raw.startsWith("Note not found")) return raw;
    const lines: string[] = [];
    if (data.resolved_from) lines.push(`(resolved from "${data.resolved_from}")`);
    lines.push(`path: ${data.path}`);
    if (data.content_hash) lines.push(`hash: ${data.content_hash}`);
    lines.push("---");
    // Reconstruct frontmatter + body
    if (data.frontmatter && Object.keys(data.frontmatter).length > 0) {
      lines.push("---");
      for (const [k, v] of Object.entries(data.frontmatter)) {
        lines.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
      }
      lines.push("---");
    }
    if (data.content) lines.push(data.content);
    return lines.join("\n");
  } catch {
    // Response isn't structured JSON — show raw text as-is
    return raw;
  }
}

function formatList(raw: string): string {
  try {
    const data = JSON.parse(raw);
    const notes = data.notes ?? [];
    if (notes.length === 0) return "No notes found.";

    const lines = [`${data.count} notes\n`];
    const pathW = Math.min(60, Math.max(...notes.map((n: any) => (n.path as string).length)));
    for (const n of notes) {
      const path = (n.path as string).padEnd(pathW);
      const type = (n.type ?? "-").padEnd(10);
      const mod = n.modified_at ? new Date(n.modified_at).toISOString().slice(0, 10) : "-";
      let line = `  ${path}  ${type}  ${mod}`;
      if (n.aliases?.length) line += `  (${n.aliases.join(", ")})`;
      lines.push(line);
    }
    return lines.join("\n");
  } catch {
    // Response isn't structured JSON — show raw text as-is
    return raw;
  }
}

function formatHistory(raw: string): string {
  try {
    const data = JSON.parse(raw);
    const entries = data.entries ?? [];
    if (entries.length === 0) return "No recent changes.";

    const lines: string[] = [];
    for (const e of entries) {
      const date = e.date ? new Date(e.date).toISOString().slice(0, 16).replace("T", " ") : "-";
      const msg = e.message ?? "";
      const files = (e.files ?? []).slice(0, 3).join(", ");
      lines.push(`  ${date}  ${msg}`);
      if (files) lines.push(`             ${files}`);
    }
    return lines.join("\n");
  } catch {
    // Response isn't structured JSON — show raw text as-is
    return raw;
  }
}

function formatStatus(raw: string): string {
  try {
    const data = JSON.parse(raw);
    const lines: string[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "object" && v !== null) {
        lines.push(`${k}:`);
        for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
          lines.push(`  ${k2}: ${v2}`);
        }
      } else {
        lines.push(`${k}: ${v}`);
      }
    }
    return lines.join("\n");
  } catch {
    // Response isn't structured JSON — show raw text as-is
    return raw;
  }
}

function formatDiagnostics(raw: string): string {
  try {
    const data = JSON.parse(raw);
    const lines: string[] = [];
    lines.push(`Total notes: ${data.total_notes}\n`);

    for (const category of ["orphans", "broken_links", "missing_frontmatter", "stale_inbox"] as const) {
      const section = data[category];
      if (!section) continue;
      const label = category.replace(/_/g, " ");
      lines.push(`${label}: ${section.count}`);
      const items = section.notes ?? section.links ?? [];
      for (const item of items.slice(0, 5)) {
        lines.push(`  - ${item}`);
      }
      if (items.length > 5) lines.push(`  ... and ${items.length - 5} more`);
      lines.push("");
    }
    return lines.join("\n");
  } catch {
    // Response isn't structured JSON — show raw text as-is
    return raw;
  }
}

// ── Key management (remote, via /keys API) ──────────────────

function keysPost(config: Config, body: unknown): Promise<{ status: number; body: string }> {
  const url = new URL("/keys", config.server);
  return post(url, body, { "Authorization": `Bearer ${config.token}` });
}

async function cmdKeysList(config: Config) {
  const res = await keysPost(config, { action: "list" });
  if (res.status === 401) { console.error("Unauthorized. Check your token in ~/.grove/cli.json"); process.exit(1); }
  const data = JSON.parse(res.body);
  const keys = data.keys ?? [];
  if (keys.length === 0) { console.log("No keys."); return; }

  console.log("\nID            Name                Scopes          Vault   Created      Last used");
  console.log("─".repeat(90));
  for (const k of keys) {
    const created = k.created_at?.slice(0, 10) ?? "-";
    const lastUsed = k.last_used_at?.slice(0, 10) ?? "never";
    console.log(
      `${(k.id ?? "").padEnd(14)}${(k.name ?? "").padEnd(20)}${(k.scopes?.join(",") ?? "").padEnd(16)}${(k.vault_id ?? "").padEnd(8)}${created.padEnd(13)}${lastUsed}`
    );
  }
  console.log();
}

async function cmdKeysCreate(config: Config, name: string) {
  if (!name) { console.error("Usage: grove keys create <name>"); process.exit(1); }
  const res = await keysPost(config, { action: "create", name });
  if (res.status === 401) { console.error("Unauthorized. Check your token in ~/.grove/cli.json"); process.exit(1); }
  const data = JSON.parse(res.body);
  console.log(`\nKey created: ${data.id}`);
  console.log(`Name:        ${data.name}`);
  console.log(`\nToken (shown once, save it now):\n`);
  console.log(`  ${data.token}\n`);
}

async function cmdKeysRevoke(config: Config, id: string) {
  if (!id) { console.error("Usage: grove keys revoke <key-id>"); process.exit(1); }
  const res = await keysPost(config, { action: "revoke", id });
  if (res.status === 401) { console.error("Unauthorized. Check your token in ~/.grove/cli.json"); process.exit(1); }
  const data = JSON.parse(res.body);
  if (data.revoked) {
    console.log(`Revoked key: ${data.revoked}`);
  } else {
    console.error(`Failed to revoke: ${JSON.stringify(data)}`);
    process.exit(1);
  }
}

// ── Commands ─────────────────────────────────────────────────────

async function cmdSearch(config: Config, query: string, flags: Record<string, string | boolean>) {
  if (!query) { console.error("Usage: grove search <query> [-n limit]"); process.exit(1); }
  const limit = Number(flags.n) || 10;
  const raw = await callTool(config, "query", {
    searches: [
      { type: "lex", query },
      { type: "vec", query },
    ],
    intent: query,
    limit,
  });
  console.log(formatSearch(raw));
}

async function cmdRead(config: Config, file: string) {
  if (!file) { console.error("Usage: grove read <path-or-title>"); process.exit(1); }
  const raw = await callTool(config, "get", { file });
  console.log(formatRead(raw));
}

async function cmdList(config: Config, pattern: string, flags: Record<string, string | boolean>) {
  if (!pattern) { console.error("Usage: grove list <glob-pattern> [--aliases]"); process.exit(1); }
  const raw = await callTool(config, "list_notes", {
    pattern,
    include_aliases: !!flags.aliases,
  });
  console.log(formatList(raw));
}

async function cmdWrite(config: Config, path: string, flags: Record<string, string | boolean>) {
  if (!path) { console.error("Usage: grove write <path> --type <type> [--tags tag1,tag2]"); process.exit(1); }
  const type = (flags.type as string) ?? "concept";
  const tags = flags.tags
    ? (flags.tags as string).split(",").map((t) => t.trim())
    : [type];

  // Read content from stdin
  const chunks: Buffer[] = [];
  process.stdin.on("data", (c) => chunks.push(c));
  await new Promise<void>((resolve) => process.stdin.on("end", resolve));
  const content = Buffer.concat(chunks).toString().trim();

  if (!content) { console.error("No content provided on stdin."); process.exit(1); }

  const raw = await callTool(config, "write_note", {
    path,
    frontmatter: JSON.stringify({ type, tags }),
    content,
  });
  console.log(formatStatus(raw));
}

async function cmdHistory(config: Config, flags: Record<string, string | boolean>) {
  const since = (flags.since as string) ?? "1 week ago";
  const raw = await callTool(config, "vault_status", { mode: "history", since });
  console.log(formatHistory(raw));
}

async function cmdStatus(config: Config) {
  const raw = await callTool(config, "vault_status", { mode: "health" });
  console.log(formatStatus(raw));
}

async function cmdDiagnostics(config: Config) {
  const raw = await callTool(config, "vault_status", { mode: "diagnostics" });
  console.log(formatDiagnostics(raw));
}

async function cmdSync(config: Config, dir: string, flags: Record<string, string | boolean>) {
  if (!dir) { console.error("Usage: grove sync <archive-sources-dir> [--dry-run]"); process.exit(1); }
  const dryRun = !!flags["dry-run"];

  // Read local archive
  console.log(`Reading archive: ${dir}`);
  const local = readArchiveSources(dir);
  console.log(`Found ${local.length} source notes locally`);

  // List existing sources on Grove
  const listRaw = await callTool(config, "list_notes", { pattern: "Sources/*" });
  const listData = JSON.parse(listRaw);
  const existingPaths = new Set<string>((listData.notes ?? []).map((n: any) => n.path));
  console.log(`Found ${existingPaths.size} source notes on Grove`);

  // Plan
  const plan = planSync(local, existingPaths);
  console.log(`\nSync plan:`);
  console.log(`  Create: ${plan.toCreate.length}`);
  console.log(`  Skip:   ${plan.skipped.length}`);

  if (plan.toCreate.length === 0) {
    console.log("\nNothing to sync.");
    return;
  }

  if (dryRun) {
    console.log("\n[dry-run] Would create:");
    for (const note of plan.toCreate) console.log(`  ${note.path}`);
    return;
  }

  // Execute
  let ok = 0;
  let fail = 0;
  for (const note of plan.toCreate) {
    try {
      const raw = await callTool(config, "write_note", {
        path: note.path,
        frontmatter: JSON.stringify(note.frontmatter),
        content: note.content,
      });
      const result = JSON.parse(raw);
      console.log(`  ✓ ${result.action} ${result.path}`);
      ok++;
    } catch (err: any) {
      console.error(`  ✗ ${note.path}: ${err.message ?? err}`);
      fail++;
    }
  }

  console.log(`\nDone: ${ok} created, ${fail} failed, ${plan.skipped.length} skipped`);
}

function cmdLint(dir: string, flags: Record<string, string | boolean>) {
  if (!dir) { console.error("Usage: grove lint <dir> [--dry-run]"); process.exit(1); }
  const dryRun = !!flags["dry-run"];

  if (dryRun) {
    // Dry run: report what would change without writing
    const { readdirSync, readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { normalizeNote } = require("./sync-sources.js");
    const entries = readdirSync(dir, { withFileTypes: true });
    let wouldChange = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const raw = readFileSync(join(dir, entry.name), "utf-8");
      if (raw !== normalizeNote(raw)) {
        console.log(`  would normalize: ${entry.name}`);
        wouldChange++;
      }
    }
    console.log(`\n${wouldChange} file(s) would be normalized`);
    return;
  }

  const { changed, total } = normalizeDir(dir);
  if (changed.length === 0) {
    console.log(`All ${total} files already normalized.`);
  } else {
    for (const f of changed) console.log(`  normalized: ${f}`);
    console.log(`\n${changed.length}/${total} file(s) normalized.`);
  }
}

function printUsage() {
  console.log(`grove — CLI client for the Grove knowledge API

Usage:
  grove search <query> [-n limit]       Search notes
  grove read <path-or-title>            Read a note
  grove list <glob> [--aliases]         List notes
  grove write <path> --type <type>      Create note (content from stdin)
  grove sync <dir> [--dry-run]          Sync archived Sources to Grove
  grove keys                            List all API keys
  grove keys create <name>              Create a new key (token shown once)
  grove keys revoke <key-id>            Revoke a key
  grove lint <dir> [--dry-run]          Normalize YAML frontmatter in .md files
  grove history [--since <date>]        Recent changes
  grove status                          Vault health
  grove diagnostics                     Run diagnostics

Config: ~/.grove/cli.json
  { "server": "https://api.grove.md", "token": "grove_live_..." }

New device setup:
  1. On an existing device:  grove keys create <device-name>
  2. Copy the token
  3. On the new device:      mkdir -p ~/.grove && echo '{"server":"https://api.grove.md","token":"grove_live_..."}' > ~/.grove/cli.json`);
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  // Local-only commands (no server needed)
  if (command === "lint") { cmdLint(positional, flags); return; }

  const config = loadConfig();

  // Key management doesn't need MCP session
  if (command === "keys") {
    const sub = positional || "list";
    const subArg = process.argv.slice(4)[0] ?? "";
    switch (sub) {
      case "list":   await cmdKeysList(config); break;
      case "create": await cmdKeysCreate(config, subArg); break;
      case "revoke": await cmdKeysRevoke(config, subArg); break;
      default:
        console.error(`Unknown keys subcommand: ${sub}`);
        console.error("Usage: grove keys [list|create|revoke]");
        process.exit(1);
    }
    return;
  }

  await initialize(config);

  switch (command) {
    case "search":  await cmdSearch(config, positional, flags); break;
    case "read":    await cmdRead(config, positional); break;
    case "list":    await cmdList(config, positional, flags); break;
    case "write":   await cmdWrite(config, positional, flags); break;
    case "sync":    await cmdSync(config, positional, flags); break;
    case "history": await cmdHistory(config, flags); break;
    case "status":  await cmdStatus(config); break;
    case "diagnostics": await cmdDiagnostics(config); break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
