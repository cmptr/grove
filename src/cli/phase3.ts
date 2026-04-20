/**
 * Phase 3 commands — agent-safe patch, human-friendly open, logout, doctor,
 * completion. Kept in a separate module so cli.ts stays manageable.
 */

import { readFileSync, statSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { GroveCliError } from "./lib/errors.js";
import { configPath, configExists, type Config } from "./lib/config.js";

// ── grove patch ────────────────────────────────────────────────
//
// Update-only (agent-safe): requires --if-hash, refuses to create new notes.
// Content comes from stdin or --content.

export interface PatchArgs {
  path: string;
  ifHash: string;
  content: string;
}

export function validatePatchArgs(args: {
  path?: string;
  ifHash?: string | boolean;
  content?: string;
}): PatchArgs {
  if (!args.path) {
    throw new GroveCliError("USAGE_ERROR", "Usage: grove patch <path> --if-hash <hash> [--content <text> | stdin]", {
      suggestions: ["grove get <path>  # to get the current hash", "grove patch <path> --if-hash <hash>"],
    });
  }
  if (typeof args.ifHash !== "string" || args.ifHash.length === 0) {
    throw new GroveCliError("USAGE_ERROR", "`grove patch` requires --if-hash to prevent lost updates.", {
      hint: "Use `grove get <path>` to fetch the current content_hash first.",
      suggestions: [`grove get ${args.path}`, `grove patch ${args.path} --if-hash <hash> --content <text>`],
    });
  }
  if (typeof args.content !== "string" || args.content.length === 0) {
    throw new GroveCliError("USAGE_ERROR", "`grove patch` requires --content or stdin input.", {
      suggestions: [`grove patch ${args.path} --if-hash ${args.ifHash} --content 'updated text'`],
    });
  }
  return { path: args.path, ifHash: args.ifHash, content: args.content };
}

// ── grove open ─────────────────────────────────────────────────
//
// Open a note in Obsidian via obsidian://open?path=... URL scheme.
// Uses `open` on macOS, `xdg-open` on Linux, `start` on Windows.

export function obsidianUrl(vaultName: string, notePath: string): string {
  const cleanPath = notePath.replace(/\.md$/i, "");
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(cleanPath)}`;
}

export function openInObsidian(vaultName: string, notePath: string): Promise<void> {
  const url = obsidianUrl(vaultName, notePath);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  return new Promise((resolve, reject) => {
    execFile(opener, [url], (err) => (err ? reject(err) : resolve()));
  });
}

// ── grove logout ───────────────────────────────────────────────
//
// Wipes ~/.grove/cli.json. Optionally revokes the token server-side (best
// effort — if the server revoke fails, the local file is still removed so
// the user isn't left with a stale config they can't use).

export async function doLogout(): Promise<{ removed_config: string | null; server_revoked: boolean }> {
  const path = configPath();
  let removedPath: string | null = null;
  if (configExists()) {
    unlinkSync(path);
    removedPath = path;
  }
  // Best-effort server revocation is Phase-3 future work — no endpoint yet.
  return { removed_config: removedPath, server_revoked: false };
}

// ── grove doctor ───────────────────────────────────────────────
//
// Self-diagnostics. Each check returns a status + remediation suggestion.

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  message: string;
  suggestion?: string;
}

export function checkConfigPerms(): DoctorCheck {
  const path = configPath();
  if (!existsSync(path)) {
    return {
      name: "config-file",
      status: "fail",
      message: `No config at ${path}`,
      suggestion: `grove init --token <grove_live_...>`,
    };
  }
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return {
      name: "config-perms",
      status: "fail",
      message: `Config has insecure mode ${mode.toString(8).padStart(3, "0")}`,
      suggestion: `chmod 600 ${path}`,
    };
  }
  return { name: "config-perms", status: "ok", message: `mode ${mode.toString(8).padStart(3, "0")}` };
}

export function checkShellHistoryForTokens(): DoctorCheck {
  const home = homedir();
  const histFiles = [join(home, ".bash_history"), join(home, ".zsh_history")];
  for (const f of histFiles) {
    if (!existsSync(f)) continue;
    try {
      const content = readFileSync(f, "utf8");
      if (/grove_live_[a-zA-Z0-9_]{8,}/.test(content)) {
        return {
          name: "history-leak",
          status: "warn",
          message: `Token pattern found in ${f} — may have leaked via shell history`,
          suggestion: `grove key rotate <id> && rm ${f}  # rotate the token and clear history`,
        };
      }
    } catch {}
  }
  return { name: "history-leak", status: "ok", message: "no tokens in shell history" };
}

export function checkServerReachable(server: string): Promise<DoctorCheck> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL("/health", server);
    } catch {
      resolve({ name: "server-url", status: "fail", message: `Invalid server URL: ${server}` });
      return;
    }
    const isHttps = url.protocol === "https:";
    const doRequest = isHttps ? httpsRequest : httpRequest;
    const req = doRequest(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: "/health",
        method: "GET",
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const dateHdr = res.headers["date"];
          if (res.statusCode && res.statusCode >= 500) {
            resolve({
              name: "server-reachable",
              status: "fail",
              message: `Server returned ${res.statusCode}`,
              suggestion: "Check server status or retry later.",
            });
          } else {
            // Opportunistic clock-skew check.
            if (dateHdr) {
              const skewSec = Math.abs(Date.now() - new Date(dateHdr).getTime()) / 1000;
              if (skewSec > 60) {
                resolve({
                  name: "clock-skew",
                  status: "warn",
                  message: `Local clock differs from server by ${Math.round(skewSec)}s`,
                  suggestion: "Sync your system clock (e.g., sudo sntp -sS time.apple.com).",
                });
                return;
              }
            }
            resolve({ name: "server-reachable", status: "ok", message: `${url.origin} responded ${res.statusCode}` });
          }
        });
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      resolve({
        name: "server-reachable",
        status: "fail",
        message: `Cannot reach ${url.origin}: ${err.message}`,
        suggestion: `Check GROVE_SERVER or your network.`,
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ name: "server-reachable", status: "fail", message: `Timeout connecting to ${url.origin}` });
    });
    req.end();
  });
}

export async function runDoctor(config: Config | null): Promise<{ checks: DoctorCheck[]; overall: "ok" | "warn" | "fail" }> {
  const checks: DoctorCheck[] = [];
  checks.push(checkConfigPerms());
  checks.push(checkShellHistoryForTokens());
  if (config) {
    checks.push(await checkServerReachable(config.server));
  }
  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");
  return { checks, overall: hasFail ? "fail" : hasWarn ? "warn" : "ok" };
}

// ── grove completion ───────────────────────────────────────────
//
// Emit shell completion script to stdout. Kept minimal: command names only
// (no flag completion yet — can extend from a registry later).

const COMMAND_NAMES = [
  // core
  "search",
  "get",
  "read",
  "list",
  "write",
  "patch",
  "status",
  "health",
  "history",
  // admin
  "key",
  "keys",
  "trail",
  "trails",
  "share",
  "invite",
  "whoami",
  "logout",
  // UX/local
  "edit",
  "open",
  "import",
  "snapshot",
  "rollback",
  "lint",
  "backfill",
  // consolidated
  "inspect",
  // meta
  "init",
  "doctor",
  "completion",
  "help",
  // legacy (deprecated, still complete so users find them)
  "ingest",
  "sync",
  "bookmarks",
  "tag-backfill",
  "diagnostics",
  "graph",
  "digest",
  "metrics",
];

export function completionBash(): string {
  const cmds = COMMAND_NAMES.join(" ");
  return `# bash completion for grove (generated by 'grove completion bash')
_grove_complete() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  if [ \$COMP_CWORD -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "${cmds}" -- "\$cur") )
    return 0
  fi
  COMPREPLY=()
}
complete -F _grove_complete grove
`;
}

export function completionZsh(): string {
  const cmds = COMMAND_NAMES.map((c) => `'${c}:grove ${c}'`).join(" \\\n    ");
  return `#compdef grove
_grove() {
  local -a commands
  commands=( \\
    ${cmds} \\
  )
  _arguments '1: :->cmd'
  case $state in
    cmd) _describe 'command' commands ;;
  esac
}
_grove "$@"
`;
}

export function completionFish(): string {
  const lines = COMMAND_NAMES.map(
    (c) => `complete -c grove -n '__fish_use_subcommand' -a '${c}' -d 'grove ${c}'`,
  ).join("\n");
  return `# fish completion for grove\n${lines}\n`;
}
