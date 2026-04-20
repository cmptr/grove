/**
 * Shared eval harness — spawns grove CLI as subprocess against stub server.
 * Mirrors test/integration/_harness.ts but exposes helpers for byte counting
 * and suggestion-extraction.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), "..", "..");
const CLI_ENTRY = join(ROOT, "src/cli.ts");

export interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  bytes: number; // stdout byte length
}

export type RouteHandler = (req: IncomingMessage, body: string) => { status: number; body: unknown; headers?: Record<string, string> };
export type RouteMap = Record<string, RouteHandler | { status: number; body: unknown; headers?: Record<string, string> }>;

export async function spawnStub(routes: RouteMap): Promise<{ baseUrl: string; configDir: string; close: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      const url = new URL(req.url || "/", "http://stub");
      const key = `${req.method} ${url.pathname}`;
      const matched = routes[key] ?? routes[`${req.method} ${url.pathname}${url.search}`];
      let resp: { status: number; body: unknown; headers?: Record<string, string> };
      if (!matched) resp = { status: 404, body: { error: "not routed" } };
      else if (typeof matched === "function") resp = matched(req, body);
      else resp = matched;
      res.statusCode = resp.status;
      res.setHeader("Content-Type", "application/json");
      for (const [k, v] of Object.entries(resp.headers ?? {})) res.setHeader(k, v);
      res.end(typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (addr == null || typeof addr === "string") throw new Error("failed to bind");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const configDir = mkdtempSync(join(tmpdir(), "grove-eval-"));
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  const cfg = join(configDir, "cli.json");
  writeFileSync(cfg, JSON.stringify({ server: baseUrl, token: "grove_live_evaltoken_abcdefg" }));
  chmodSync(cfg, 0o600);

  return {
    baseUrl,
    configDir,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        rmSync(configDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

export function runCli(configDir: string, args: string[], opts: { timeoutMs?: number; stdin?: string } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("npx", ["tsx", CLI_ENTRY, ...args], {
      cwd: ROOT,
      env: { ...process.env, GROVE_CONFIG_DIR: configDir, GROVE_TEST_SEED: "42" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
      bytes += c.length;
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    if (opts.stdin != null) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 20_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exit: code ?? 0, stdout, stderr, duration_ms: Date.now() - t0, bytes });
    });
  });
}

export function reportHeader(name: string): void {
  process.stdout.write(`\n=== ${name} ===\n`);
}

export function pass(label: string): void {
  process.stdout.write(`  \u001b[32m✓\u001b[0m ${label}\n`);
}

export function fail(label: string, detail?: string): void {
  process.stdout.write(`  \u001b[31m✗\u001b[0m ${label}\n`);
  if (detail) process.stdout.write(`     ${detail}\n`);
}
