/**
 * Git operations, QMD reindex, and file listing for the vault.
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { parse as yamlParse } from "yaml";

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
  tags?: string[];
  aliases?: string[];
  modified_at: string;
}

// ── Helper ───────────────────────────────────────────────────────────

/** Detect the upstream remote and default branch for a repo. Cached per vault path. */
const gitRemoteCache = new Map<string, { remote: string; branch: string }>();

export async function getRemoteAndBranch(
  vaultPath: string,
): Promise<{ remote: string; branch: string }> {
  const cached = gitRemoteCache.get(vaultPath);
  if (cached) return cached;

  let remote = "origin";
  let branch = "main";

  try {
    // Detect remote from the current branch's tracking config
    const currentBranch = (
      await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], vaultPath)
    ).trim();
    const trackingRemote = (
      await exec("git", ["config", "--get", `branch.${currentBranch}.remote`], vaultPath)
    ).trim();
    if (trackingRemote) remote = trackingRemote;
  } catch {
    // No tracking config for current branch — try listing remotes
    try {
      // Fall back: first remote listed
      const remotes = (await exec("git", ["remote"], vaultPath)).trim();
      const first = remotes.split("\n")[0]?.trim();
      if (first) remote = first;
    } catch {
      // keep default "origin"
    }
  }

  try {
    // Detect default branch via symbolic-ref of remote HEAD
    const ref = (
      await exec(
        "git",
        ["symbolic-ref", `refs/remotes/${remote}/HEAD`],
        vaultPath,
      )
    ).trim();
    // ref looks like "refs/remotes/origin/main"
    const last = ref.split("/").pop();
    if (last) branch = last;
  } catch {
    // keep default "main"
  }

  const result = { remote, branch };
  gitRemoteCache.set(vaultPath, result);
  return result;
}

export function exec(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/usr/bin:/usr/local/bin` } }, (err, stdout, stderr) => {
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
  const { remote, branch } = await getRemoteAndBranch(vaultPath);
  await exec("git", ["fetch", remote], vaultPath);
  try {
    await exec("git", ["rebase", `${remote}/${branch}`], vaultPath);
  } catch (err) {
    await exec("git", ["rebase", "--abort"], vaultPath).catch(() => {
      // Abort may fail if rebase already unwound — safe to ignore
    });
    console.error("[vault-ops] rebase conflict — aborted, caller should retry");
    throw err;
  }
  await exec("git", ["push", remote, branch], vaultPath);
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

  const { remote, branch } = await getRemoteAndBranch(vaultPath);
  const unpushed = await exec(
    "git",
    ["log", `${remote}/${branch}..HEAD`, "--oneline"],
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
): { type: string | null; tags?: string[]; aliases?: string[] } {
  if (!head.startsWith("---")) return { type: null };
  const end = head.indexOf("\n---", 3);
  if (end === -1) return { type: null };
  const raw = head.slice(4, end);

  let parsed: Record<string, unknown>;
  try {
    parsed = yamlParse(raw) ?? {};
  } catch {
    // Invalid YAML frontmatter — treat as no metadata
    return { type: null };
  }

  const type =
    typeof parsed.type === "string" ? parsed.type : null;
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((t): t is string => typeof t === "string")
    : typeof parsed.tags === "string" ? [parsed.tags]
    : undefined;
  const aliases = Array.isArray(parsed.aliases)
    ? parsed.aliases.filter((a): a is string => typeof a === "string")
    : undefined;

  return { type, tags, aliases };
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
      tags: fm.tags,
      modified_at: stat.mtime.toISOString(),
    };
    if (opts?.includeAliases && fm.aliases) {
      entry.aliases = fm.aliases;
    }
    results.push(entry);
  }

  return results;
}
