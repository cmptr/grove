#!/usr/bin/env tsx
/**
 * Eval 4b: suggestion actionability.
 *
 * For every error path we can reach from the CLI, capture the envelope and
 * verify that `error.suggestions[]` contains only executable grove commands
 * (or shell commands that fix the specific problem, e.g., `chmod 600 ...`).
 *
 * Drift test: if a maintainer adds prose instead of an executable suggestion,
 * this eval fails.
 *
 * Gate: 100% of suggestions parse as either a grove invocation or a whitelisted
 * shell command. Exit 1 if any fail.
 */

import { spawnStub, runCli, reportHeader, pass, fail } from "./_eval-harness.js";
import { chmodSync } from "node:fs";
import { join } from "node:path";

interface Case {
  name: string;
  args: string[];
  route_key?: string;
  route_body?: unknown;
  route_status?: number;
  mutate_config?: (configDir: string) => void;
  expected_code: string;
  expected_exit: number;
}

const CASES: Case[] = [
  {
    name: "CONFIG_INSECURE (0644 cli.json)",
    args: ["whoami", "--format", "json"],
    mutate_config: (dir) => chmodSync(join(dir, "cli.json"), 0o644),
    expected_code: "CONFIG_INSECURE",
    expected_exit: 2,
  },
  {
    name: "TOKEN_IN_ARGV",
    args: ["search", "x", "--token=grove_live_abcdefg12345", "--format", "json"],
    expected_code: "TOKEN_IN_ARGV",
    expected_exit: 1,
  },
];

// Shell command prefixes that are allowed as suggestions (recovery actions, not grove commands).
const SHELL_PREFIXES = ["chmod ", "mkdir ", "rm ", "cp ", "mv ", "cat ", "export ", "GROVE_"];

function isExecutableSuggestion(s: string): { ok: boolean; reason?: string } {
  const t = s.trim();
  if (t.length === 0) return { ok: false, reason: "empty" };
  if (t.startsWith("grove ")) return { ok: true };
  if (t.startsWith("grove_live_")) return { ok: false, reason: "bare token — prose in suggestion" };
  for (const p of SHELL_PREFIXES) {
    if (t.startsWith(p)) return { ok: true };
  }
  // Must NOT look like prose.
  if (t.split(" ").length > 8) return { ok: false, reason: "too wordy (>8 words) — likely prose" };
  if (/[.!?]$/.test(t)) return { ok: false, reason: "ends with sentence punctuation — likely prose" };
  return { ok: false, reason: `unrecognized prefix; start with 'grove' or a shell command verb (${SHELL_PREFIXES.join(",")})` };
}

async function main(): Promise<void> {
  reportHeader("eval/suggestions");

  const routes: Record<string, { status: number; body: unknown }> = {};
  const stub = await spawnStub(routes);

  let failures = 0;
  const report: Record<string, unknown> = {};

  for (const c of CASES) {
    if (c.mutate_config) c.mutate_config(stub.configDir);
    const r = await runCli(stub.configDir, c.args);
    if (r.exit !== c.expected_exit) {
      fail(c.name, `exit=${r.exit} expected=${c.expected_exit} stdout=${r.stdout.slice(0, 300)}`);
      failures++;
      continue;
    }
    let env;
    try {
      env = JSON.parse(r.stdout);
    } catch {
      fail(c.name, "stdout was not valid JSON");
      failures++;
      continue;
    }
    if (env.ok !== false) {
      fail(c.name, "envelope is not an error");
      failures++;
      continue;
    }
    if (env.error.code !== c.expected_code) {
      fail(c.name, `code=${env.error.code} expected=${c.expected_code}`);
      failures++;
      continue;
    }
    const suggestions: string[] = env.error.suggestions ?? [];
    if (suggestions.length === 0) {
      fail(c.name, "no suggestions — every error must include at least one");
      failures++;
      continue;
    }
    const verdicts = suggestions.map((s) => ({ s, v: isExecutableSuggestion(s) }));
    const bad = verdicts.filter((v) => !v.v.ok);
    report[c.name] = { code: env.error.code, suggestions, verdicts };
    if (bad.length > 0) {
      fail(c.name, `non-executable suggestion(s): ${bad.map((b) => `"${b.s}" (${b.v.reason})`).join("; ")}`);
      failures++;
    } else {
      pass(`${c.name}: ${suggestions.length} executable suggestion(s)`);
    }
  }

  await stub.close();

  process.stdout.write(`\n  summary: ${CASES.length - failures}/${CASES.length} cases have executable suggestions\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`eval/suggestions crashed: ${e}\n`);
  process.exit(2);
});
