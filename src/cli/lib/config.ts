/**
 * Config loading with file-permission enforcement.
 *
 * Precedence:
 *   1. GROVE_SERVER + GROVE_TOKEN env vars (both must be set)
 *   2. Config file at $GROVE_CONFIG_DIR/cli.json (default: ~/.grove/cli.json)
 *
 * Permissions: config file MUST be mode 0600 (or 0400). Group/world readable refused.
 *   Rationale: token is a bearer credential; world-readable home dir is common.
 *
 * Tokens in argv are banned (ps aux leak). `--token` is only accepted by
 * `grove init` where it writes to the config file with 0600.
 */

import { statSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GroveCliError } from "./errors.js";

export interface Config {
  server: string;
  token: string;
}

export function configDir(): string {
  return process.env.GROVE_CONFIG_DIR ?? join(homedir(), ".grove");
}

export function configPath(): string {
  return join(configDir(), "cli.json");
}

/** Fast probe — does config exist? Does NOT validate perms. */
export function configExists(): boolean {
  try {
    statSync(configPath());
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(): Config {
  const envServer = process.env.GROVE_SERVER;
  const envToken = process.env.GROVE_TOKEN;
  if (envServer && envToken) return { server: envServer, token: envToken };

  const path = configPath();
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new GroveCliError("CONFIG_MISSING", `Config not found: ${path}`, {
      hint: "Create it with `grove init --token <token>`.",
      suggestions: ["grove init --token <grove_live_...>"],
    });
  }

  // Enforce mode 0600 / 0400. Any group/world bits → refuse.
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new GroveCliError(
      "CONFIG_INSECURE",
      `Config ${path} has mode ${mode.toString(8).padStart(3, "0")}; must be 600 (owner-only).`,
      {
        hint: `Run: chmod 600 ${path}`,
        suggestions: [`chmod 600 ${path}`],
      },
    );
  }

  let parsed: { server?: string; token?: string };
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new GroveCliError("CONFIG_MISSING", `Config at ${path} is not valid JSON.`, {
      hint: "Re-run `grove init` to regenerate it.",
      suggestions: ["grove init --token <grove_live_...>"],
      details: { reason: String(e) },
    });
  }

  const server = envServer ?? parsed.server;
  const token = envToken ?? parsed.token;
  if (!server || !token) {
    throw new GroveCliError("CONFIG_MISSING", `Config at ${path} is incomplete (missing server or token).`, {
      hint: "Re-run `grove init` to regenerate it.",
      suggestions: ["grove init --token <grove_live_...>"],
    });
  }
  return { server, token };
}

/** Write config atomically with mode 0600 (and 0700 parent dir). */
export function writeConfig(cfg: Config): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Best-effort chmod on parent (mkdirSync mode is masked by umask).
  try {
    chmodSync(dir, 0o700);
  } catch {}
  const path = configPath();
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {}
  return path;
}
