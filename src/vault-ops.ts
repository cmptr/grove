/**
 * Git operations, QMD reindex, and file listing for the vault.
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";

// ── Types ────────────────────────────────────────────────────────────

export interface HistoryEntry {
  sha: string;
  date: string;
  message: string;
  author: string;
  files: string[];
}

export interface NoteEntry {
  path: string;
  name: string;
  type: string | null;
  aliases?: string[];
  modified_at: string;
}

// ── Helper ───────────────────────────────────────────────────────────

export function exec(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
): Promise<string> {
  // Use full path for git/qmd in case PM2 doesn't inherit PATH
  const fullCmd = cmd === "git" ? "/usr/bin/git" : cmd === "qmd" ? "qmd" : cmd;
  return new Promise((resolve, reject) => {
    execFile(fullCmd, args, { cwd, timeout: timeoutMs, env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/usr/bin:/usr/local/bin` } }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        reject(new Error(`${cmd} ${args.join(" ")}: ${msg}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

// ── Git operations ───────────────────────────────────────────────────

export async function gitCommit(
  vaultPath: string,
  filePath: string,
  message: string,
): Promise<string> {
  await exec("git", ["add", filePath], vaultPath);
  await exec("git", ["commit", "-m", message], vaultPath);
  const sha = await exec("git", ["rev-parse", "HEAD"], vaultPath);
  return sha.trim();
}

export async function gitPush(vaultPath: string): Promise<void> {
  await exec("git", ["fetch", "origin"], vaultPath);
  try {
    await exec("git", ["rebase", "origin/main"], vaultPath);
  } catch (err) {
    await exec("git", ["rebase", "--abort"], vaultPath).catch(() => {});
    console.error("[vault-ops] rebase conflict — aborted, caller should retry");
    throw err;
  }
  await exec("git", ["push", "origin", "main"], vaultPath);
}

export async function gitLog(
  vaultPath: string,
  opts?: { since?: string; pathPrefix?: string; limit?: number },
): Promise<HistoryEntry[]> {
  const limit = opts?.limit ?? 50;
  const args = [
    "log",
    `--max-count=${limit}`,
    "--format=%H%n%aI%n%s%n%an",
    "--name-only",
  ];
  if (opts?.since) args.push(`--since=${opts.since}`);
  args.push("--");
  if (opts?.pathPrefix) args.push(opts.pathPrefix);

  const raw = await exec("git", args, vaultPath);
  const entries: HistoryEntry[] = [];
  const blocks = raw.split("\n\n");

  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length < 4) continue;
    entries.push({
      sha: lines[0],
      date: lines[1],
      message: lines[2],
      author: lines[3],
      files: lines.slice(4),
    });
  }

  return entries;
}

export async function startupRecovery(vaultPath: string): Promise<void> {
  const status = await exec("git", ["status", "--porcelain"], vaultPath);
  if (status.trim()) {
    console.log("[vault-ops] recovering uncommitted changes");
    await exec("git", ["add", "-A"], vaultPath);
    try {
      await exec(
        "git",
        ["commit", "-m", "grove (recovery): uncommitted changes from crash"],
        vaultPath,
      );
    } catch {
      // Nothing to commit (e.g., only gitignored files changed)
    }
  }

  const unpushed = await exec(
    "git",
    ["log", "origin/main..HEAD", "--oneline"],
    vaultPath,
  );
  if (unpushed.trim()) {
    console.log("[vault-ops] pushing unpushed commits");
    await gitPush(vaultPath);
  }
}

// ── QMD reindex ──────────────────────────────────────────────────────

export async function qmdReindex(_filePath: string): Promise<void> {
  try {
    await exec("qmd", ["update"], "/tmp", 10_000);
  } catch (err) {
    console.warn(
      "[vault-ops] qmd reindex failed (search may be stale):",
      (err as Error).message,
    );
  }
}

// ── File listing ─────────────────────────────────────────────────────

function walkMd(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMd(full, acc);
    } else if (entry.name.endsWith(".md")) {
      acc.push(full);
    }
  }
  return acc;
}

function parseFrontmatter(
  head: string,
): { type: string | null; aliases?: string[] } {
  if (!head.startsWith("---")) return { type: null };
  const end = head.indexOf("\n---", 3);
  if (end === -1) return { type: null };
  const yaml = head.slice(4, end);

  let type: string | null = null;
  let aliases: string[] | undefined;

  for (const line of yaml.split("\n")) {
    const tMatch = line.match(/^type:\s*(.+)/);
    if (tMatch) type = tMatch[1].trim().replace(/^["']|["']$/g, "");

    const aMatch = line.match(/^aliases:\s*\[(.+)]/);
    if (aMatch) {
      aliases = aMatch[1].split(",").map((a) =>
        a.trim().replace(/^["']|["']$/g, ""),
      );
    }
  }

  return { type, aliases };
}

export function listNotes(
  vaultPath: string,
  pattern: string,
  opts?: { includeAliases?: boolean },
): NoteEntry[] {
  const allFiles = walkMd(vaultPath);
  const re = new RegExp(
    "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
  );

  const results: NoteEntry[] = [];
  for (const abs of allFiles) {
    const rel = relative(vaultPath, abs);
    if (!re.test(rel)) continue;

    const head = readFileSync(abs, "utf-8").slice(0, 500);
    const fm = parseFrontmatter(head);
    const stat = statSync(abs);

    const entry: NoteEntry = {
      path: rel,
      name: basename(abs, ".md"),
      type: fm.type,
      modified_at: stat.mtime.toISOString(),
    };
    if (opts?.includeAliases && fm.aliases) {
      entry.aliases = fm.aliases;
    }
    results.push(entry);
  }

  return results;
}
