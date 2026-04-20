#!/usr/bin/env tsx
/**
 * Autonomous iteration loop driver.
 *
 * Runs test tiers in sequence. On failure, emits structured JSON to
 * failures/<tier>.json and exits non-zero so the driving agent can
 * read, patch, and re-run.
 *
 * Halt conditions:
 *   - All tiers green → exit 0
 *   - Same failure fingerprint observed 3× in a row → exit 77 (REQUIRES_HUMAN)
 *   - Cumulative iteration count >= 30 → exit 77
 *
 * Usage:
 *   tsx scripts/iterate.ts                  # run all tiers once
 *   tsx scripts/iterate.ts --tier 1         # only Tier 1 (unit)
 *   tsx scripts/iterate.ts --phase 1        # only phase-1 gates
 *   tsx scripts/iterate.ts --loop           # run, record failures, exit (agent reads + patches + re-runs)
 *
 * Exit codes:
 *   0  = all green
 *   1  = tier failed (failure JSON written)
 *   77 = human input required (same failure 3× or iteration cap)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), "..");
const FAILURES_DIR = join(ROOT, "failures");
const STATE_PATH = join(FAILURES_DIR, "state.json");
const POSTMORTEM_PATH = join(FAILURES_DIR, "postmortem.md");
const MAX_ITERATIONS = 30;
const SAME_FAILURE_LIMIT = 3;

type Tier = 1 | 2 | 3 | 4;

interface TierResult {
  tier: Tier;
  name: string;
  passed: boolean;
  failures: FailureEntry[];
  skipped?: boolean;
  skipReason?: string;
}

interface FailureEntry {
  suite: string;
  name: string;
  file?: string;
  line?: number;
  message: string;
  expected?: string;
  actual?: string;
  likely_cause?: string;
  next_action?: string;
}

interface IterState {
  cumulative_iteration: number;
  last_fingerprints: string[]; // ring buffer, last 5
}

function loadState(): IterState {
  if (!existsSync(STATE_PATH)) return { cumulative_iteration: 0, last_fingerprints: [] };
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { cumulative_iteration: 0, last_fingerprints: [] };
  }
}

function saveState(s: IterState): void {
  mkdirSync(FAILURES_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function fingerprint(failures: FailureEntry[]): string {
  const canonical = failures
    .map((f) => `${f.suite}::${f.name}::${f.message.slice(0, 100)}`)
    .sort()
    .join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function clearFailureFiles(): void {
  if (!existsSync(FAILURES_DIR)) return;
  for (const f of readdirSync(FAILURES_DIR)) {
    if (f.startsWith("tier") && f.endsWith(".json")) {
      try {
        rmSync(join(FAILURES_DIR, f));
      } catch {}
    }
  }
}

// ── Tier runners ────────────────────────────────────────────────

function runTier1(): TierResult {
  const reportPath = join(FAILURES_DIR, "tier1-raw.json");
  mkdirSync(FAILURES_DIR, { recursive: true });
  const res = spawnSync(
    "npx",
    ["vitest", "run", "test/unit/", "--reporter=json", `--outputFile=${reportPath}`],
    { cwd: ROOT, encoding: "utf8" },
  );

  const failures: FailureEntry[] = [];
  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      for (const suite of report.testResults ?? []) {
        for (const t of suite.assertionResults ?? []) {
          if (t.status === "failed") {
            failures.push({
              suite: suite.name ?? "?",
              name: t.fullName ?? t.title,
              file: suite.name,
              message: (t.failureMessages ?? []).join("\n").slice(0, 500),
            });
          }
        }
      }
    } catch (e) {
      failures.push({
        suite: "__runner__",
        name: "parse-report",
        message: `Could not parse vitest report: ${e}`,
      });
    }
  } else if (res.status !== 0) {
    failures.push({
      suite: "__runner__",
      name: "vitest-crash",
      message: (res.stderr || res.stdout || "").slice(-1000),
    });
  }

  return { tier: 1, name: "unit", passed: failures.length === 0 && res.status === 0, failures };
}

function runTier2(): TierResult {
  // Integration tests — only run if directory exists AND has tests.
  const intDir = join(ROOT, "test/integration");
  if (!existsSync(intDir)) {
    return { tier: 2, name: "integration", passed: true, failures: [], skipped: true, skipReason: "no test/integration/ yet" };
  }
  const files = readdirSync(intDir).filter((f) => f.endsWith(".test.ts"));
  if (files.length === 0) {
    return { tier: 2, name: "integration", passed: true, failures: [], skipped: true, skipReason: "no integration tests yet" };
  }

  const reportPath = join(FAILURES_DIR, "tier2-raw.json");
  const res = spawnSync(
    "npx",
    ["vitest", "run", "test/integration/", "--reporter=json", `--outputFile=${reportPath}`],
    { cwd: ROOT, encoding: "utf8", timeout: 120_000 },
  );

  const failures: FailureEntry[] = [];
  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      for (const suite of report.testResults ?? []) {
        for (const t of suite.assertionResults ?? []) {
          if (t.status === "failed") {
            failures.push({
              suite: suite.name ?? "?",
              name: t.fullName ?? t.title,
              message: (t.failureMessages ?? []).join("\n").slice(0, 500),
            });
          }
        }
      }
    } catch (e) {
      failures.push({ suite: "__runner__", name: "parse-report", message: String(e) });
    }
  }

  return { tier: 2, name: "integration", passed: failures.length === 0 && res.status === 0, failures };
}

function runTier3(): TierResult {
  const smokeDir = join(ROOT, "test/smoke");
  if (!existsSync(smokeDir)) {
    return { tier: 3, name: "smoke", passed: true, failures: [], skipped: true, skipReason: "no test/smoke/ yet" };
  }
  // Plain bash scripts ending with `.smoke.sh` — no bats dependency.
  const files = readdirSync(smokeDir)
    .filter((f) => f.endsWith(".smoke.sh"))
    .sort(); // deterministic order
  if (files.length === 0) {
    return { tier: 3, name: "smoke", passed: true, failures: [], skipped: true, skipReason: "no smoke tests yet" };
  }

  const failures: FailureEntry[] = [];
  for (const f of files) {
    const full = join(smokeDir, f);
    const res = spawnSync("bash", [full], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
    if (res.status !== 0) {
      failures.push({
        suite: f,
        name: f.replace(".smoke.sh", ""),
        message: (res.stdout + "\n" + res.stderr).slice(-2000),
      });
    }
  }
  return { tier: 3, name: "smoke", passed: failures.length === 0, failures };
}

function runTier4(): TierResult {
  const evalDir = join(ROOT, "test/eval");
  if (!existsSync(evalDir)) {
    return { tier: 4, name: "eval", passed: true, failures: [], skipped: true, skipReason: "no test/eval/ yet" };
  }
  const files = readdirSync(evalDir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"));
  if (files.length === 0) {
    return { tier: 4, name: "eval", passed: true, failures: [], skipped: true, skipReason: "no evals yet" };
  }

  const failures: FailureEntry[] = [];
  for (const f of files) {
    const full = join(evalDir, f);
    const res = spawnSync("npx", ["tsx", full], { cwd: ROOT, encoding: "utf8", timeout: 600_000 });
    if (res.status !== 0) {
      failures.push({
        suite: f,
        name: f.replace(".ts", ""),
        message: (res.stdout + "\n" + res.stderr).slice(-1500),
      });
    }
  }
  return { tier: 4, name: "eval", passed: failures.length === 0, failures };
}

// ── Reporting ──────────────────────────────────────────────────

function writeFailureReport(result: TierResult, state: IterState): void {
  const path = join(FAILURES_DIR, `tier${result.tier}.json`);
  const report = {
    tier: result.tier,
    name: result.name,
    cumulative_iteration: state.cumulative_iteration,
    max_iterations: MAX_ITERATIONS,
    failure_count: result.failures.length,
    failures: result.failures,
  };
  mkdirSync(FAILURES_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
  process.stderr.write(`\n→ failure report written to ${path}\n`);
}

function writePostmortem(state: IterState, lastResult: TierResult): void {
  const lines: string[] = [];
  lines.push(`# Grove iterate.ts postmortem`);
  lines.push("");
  lines.push(`**Halt reason:** same failure fingerprint observed ${SAME_FAILURE_LIMIT}× in a row OR iteration cap ${MAX_ITERATIONS} reached.`);
  lines.push("");
  lines.push(`- Cumulative iterations: ${state.cumulative_iteration}`);
  lines.push(`- Recent fingerprints: ${state.last_fingerprints.slice(-5).join(", ")}`);
  lines.push(`- Last tier run: ${lastResult.name} (tier ${lastResult.tier})`);
  lines.push("");
  lines.push(`## Last failures`);
  for (const f of lastResult.failures.slice(0, 20)) {
    lines.push(`- **${f.suite}** → ${f.name}`);
    lines.push(`  ${f.message.slice(0, 200)}`);
  }
  lines.push("");
  lines.push("_Human review required._");
  mkdirSync(FAILURES_DIR, { recursive: true });
  writeFileSync(POSTMORTEM_PATH, lines.join("\n"));
  process.stderr.write(`\n⚠️  Wrote postmortem to ${POSTMORTEM_PATH}\n`);
}

// ── Main ───────────────────────────────────────────────────────

function parseArgs(argv: string[]): { tier?: Tier; phase?: number; once: boolean; loop: boolean } {
  const out = { once: true, loop: false } as { tier?: Tier; phase?: number; once: boolean; loop: boolean };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tier") out.tier = Number(argv[++i]) as Tier;
    else if (a === "--phase") out.phase = Number(argv[++i]);
    else if (a === "--once") out.once = true;
    else if (a === "--loop") out.loop = true;
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const state = loadState();
  state.cumulative_iteration += 1;

  if (state.cumulative_iteration > MAX_ITERATIONS) {
    process.stderr.write(`\n⚠️  Iteration cap ${MAX_ITERATIONS} reached. Halting.\n`);
    writePostmortem(state, { tier: 1, name: "unknown", passed: false, failures: [] });
    saveState({ cumulative_iteration: state.cumulative_iteration, last_fingerprints: state.last_fingerprints });
    process.exit(77);
  }

  const tiers: (() => TierResult)[] = args.tier
    ? [[runTier1, runTier2, runTier3, runTier4][args.tier - 1]!]
    : [runTier1, runTier2, runTier3, runTier4];

  clearFailureFiles();

  let firstFailure: TierResult | null = null;
  for (const runner of tiers) {
    const t0 = Date.now();
    const result = runner();
    const dt = Date.now() - t0;
    if (result.skipped) {
      process.stderr.write(`⏭  tier${result.tier} (${result.name}): skipped — ${result.skipReason} (${dt}ms)\n`);
      continue;
    }
    if (result.passed) {
      process.stderr.write(`✓ tier${result.tier} (${result.name}): ${dt}ms\n`);
    } else {
      process.stderr.write(`✗ tier${result.tier} (${result.name}): ${result.failures.length} failure(s) (${dt}ms)\n`);
      writeFailureReport(result, state);
      if (!firstFailure) firstFailure = result;
      break; // stop at first failing tier
    }
  }

  if (firstFailure) {
    const fp = fingerprint(firstFailure.failures);
    state.last_fingerprints.push(fp);
    state.last_fingerprints = state.last_fingerprints.slice(-5);
    saveState(state);

    // Check for same-failure-3x
    const tail = state.last_fingerprints.slice(-SAME_FAILURE_LIMIT);
    if (tail.length >= SAME_FAILURE_LIMIT && tail.every((x) => x === fp)) {
      writePostmortem(state, firstFailure);
      process.exit(77);
    }
    process.exit(1);
  }

  // All green.
  process.stderr.write(`\n✅ all tiers green (iteration ${state.cumulative_iteration}/${MAX_ITERATIONS})\n`);
  // Reset state on success so future runs start fresh.
  saveState({ cumulative_iteration: 0, last_fingerprints: [] });
  process.exit(0);
}

main();
