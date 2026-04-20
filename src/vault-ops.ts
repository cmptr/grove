/**
 * Git operations, QMD reindex, and file listing for the vault.
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, basename, resolve as resolvePath } from "node:path";
import { parse as yamlParse } from "yaml";
import {
  decryptContent,
  encryptContent,
  getVaultKey,
  isEncrypted,
} from "./crypto.js";

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
  private?: boolean;
  modified_at: string;
}

// ── Transparent encryption ──────────────────────────────────────────
//
// When a vault has an unlocked key in the crypto registry, all reads go
// through `readNoteFile` (which decrypts) and all writes go through
// `writeNoteFile` (which encrypts). Files with no matching key, or files on
// disk that don't carry the encryption header, pass through as plaintext so
// mixed vaults migrate one write at a time.

/** Resolve the vault key for an arbitrary path inside the vault. */
function vaultKeyForPath(absPath: string): Buffer | null {
  const canonical = resolvePath(absPath);
  for (const candidate of keyLookupCandidates(canonical)) {
    const key = getVaultKey(candidate);
    if (key) return key;
  }
  return null;
}

function* keyLookupCandidates(absPath: string): Generator<string> {
  // Walk up the path; match the deepest registered vault root.
  let current = absPath;
  while (current && current !== "/" && current !== ".") {
    yield current;
    const next = current.slice(0, current.lastIndexOf("/"));
    if (next === current) break;
    current = next || "/";
  }
}

/** Read a vault file, decrypting transparently if the file is encrypted. */
export function readNoteFile(absPath: string): string {
  const raw = readFileSync(absPath, "utf-8");
  if (!isEncrypted(raw)) return raw;
  const key = vaultKeyForPath(absPath);
  if (!key) {
    throw new Error(
      `[vault-ops] cannot read ${absPath}: file is encrypted but vault is locked`,
    );
  }
  return decryptContent(raw, key);
}

/** Write a vault file, encrypting transparently when a vault key is set. */
export function writeNoteFile(absPath: string, content: string): void {
  const key = vaultKeyForPath(absPath);
  const payload = key ? encryptContent(content, key) : content;
  writeFileSync(absPath, payload, "utf-8");
}

// ── Frontmatter cache ────────────────────────────────────────────────
// Parsing frontmatter out of encrypted files means decrypting each file on
// every `listNotes` call — expensive on large vaults. Cache the parsed
// frontmatter keyed by absolute path + mtime, so listNotes only pays the
// decryption cost for notes that changed since the last listing.

interface CachedFm {
  mtimeMs: number;
  size: number;
  fm: ParsedFrontmatter;
}

const frontmatterCache = new Map<string, CachedFm>();

/** Drop a specific path from the cache (after a write). */
export function invalidateFrontmatterCache(absPath: string): void {
  frontmatterCache.delete(absPath);
}

/** Clear the whole cache (e.g. on vault lock). */
export function clearFrontmatterCache(): void {
  frontmatterCache.clear();
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

interface ParsedFrontmatter {
  type: string | null;
  tags?: string[];
  aliases?: string[];
  private?: boolean;
}

function parseFrontmatter(head: string): ParsedFrontmatter {
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
  const isPrivate = parsed.private === true ? true : undefined;

  return { type, tags, aliases, ...(isPrivate && { private: isPrivate }) };
}

function getFrontmatter(absPath: string, stat: { mtimeMs: number; size: number }): ParsedFrontmatter {
  const cached = frontmatterCache.get(absPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.fm;
  }

  // Encrypted files have no reliable "head slice" — base64-decode first.
  const raw = readFileSync(absPath, "utf-8");
  let head: string;
  if (isEncrypted(raw)) {
    const key = vaultKeyForPath(absPath);
    if (!key) {
      // Locked — can't parse frontmatter. Return empty so listing still works.
      const fm: ParsedFrontmatter = { type: null };
      frontmatterCache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, fm });
      return fm;
    }
    try {
      head = decryptContent(raw, key).slice(0, 500);
    } catch {
      // Wrong key (e.g. mixed-key test fixtures, or a file left over from a
      // previous vault key). Don't fail the whole listing — just skip this
      // note's metadata.
      const fm: ParsedFrontmatter = { type: null };
      frontmatterCache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, fm });
      return fm;
    }
  } else {
    head = raw.slice(0, 500);
  }
  const fm = parseFrontmatter(head);
  frontmatterCache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, fm });
  return fm;
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

    const stat = statSync(abs);
    const fm = getFrontmatter(abs, { mtimeMs: stat.mtimeMs, size: stat.size });

    const entry: NoteEntry = {
      path: rel,
      name: basename(abs, ".md"),
      type: fm.type,
      tags: fm.tags,
      modified_at: stat.mtime.toISOString(),
    };
    if (fm.private) entry.private = true;
    if (opts?.includeAliases && fm.aliases) {
      entry.aliases = fm.aliases;
    }
    results.push(entry);
  }

  return results;
}
