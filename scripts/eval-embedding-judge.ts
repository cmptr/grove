#!/usr/bin/env tsx
/**
 * Evaluate embedding-based content filtering for groves.
 *
 * Approach: Embed a grove's topic description and each note's title.
 * Cosine similarity above threshold → allow. Below → deny.
 *
 * Tests against labeled eval data to measure precision and recall.
 *
 * Usage:
 *   npx tsx scripts/eval-embedding-judge.ts [--threshold 0.3] [--server http://localhost:8090]
 */

import { readFileSync } from "node:fs";
import { request } from "node:http";

// ── Config ──────────────────────────────────────────────────────────

const TEI_SERVER = process.argv.includes("--server")
  ? process.argv[process.argv.indexOf("--server") + 1]
  : "http://127.0.0.1:8090";

const THRESHOLD_ARG = process.argv.includes("--threshold")
  ? parseFloat(process.argv[process.argv.indexOf("--threshold") + 1])
  : null;

const EVAL_FILE = "test/fixtures/content-filter-eval.json";

// Grove definition: "AI Research" — the test grove
const GROVE_ALLOW = "artificial intelligence, machine learning, LLMs, AI agents, coding, software engineering, design systems, generative art, creative coding, startups, technology, MCP, Claude, programming";
const GROVE_DENY = "health, therapy, mental health, medications, finances, investments, taxes, relationships, sexuality, family dysfunction, pregnancy, personal struggles, anxiety, OCD, addiction";

// ── Helpers ─────────────────────────────────────────────────────────

interface EvalEntry {
  path: string;
  label: "sensitive" | "safe-ai" | "safe-general" | "ambiguous";
  reason: string;
}

function noteTitle(path: string): string {
  return path.split("/").pop()?.replace(".md", "") ?? path;
}

async function embed(texts: string[]): Promise<number[][]> {
  const url = new URL("/embed", TEI_SERVER);
  const body = JSON.stringify({ inputs: texts });

  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (e) {
            reject(new Error(`TEI parse error: ${Buffer.concat(chunks).toString().slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const entries: EvalEntry[] = JSON.parse(readFileSync(EVAL_FILE, "utf-8"));

  // Skip ambiguous — they're edge cases, not ground truth
  const testable = entries.filter((e) => e.label !== "ambiguous");
  console.log(`Loaded ${testable.length} labeled notes (${entries.length - testable.length} ambiguous skipped)`);

  // Embed grove descriptions
  console.log("Embedding grove topic descriptions...");
  const [allowVec, denyVec] = await embed([GROVE_ALLOW, GROVE_DENY]);

  // Embed all note titles in batches
  console.log("Embedding note titles...");
  const titles = testable.map((e) => noteTitle(e.path));
  const BATCH = 32;
  const titleVecs: number[][] = [];
  for (let i = 0; i < titles.length; i += BATCH) {
    const batch = titles.slice(i, i + BATCH);
    const vecs = await embed(batch);
    if (!Array.isArray(vecs)) { console.error("TEI returned non-array:", typeof vecs, JSON.stringify(vecs).slice(0, 200)); process.exit(1); }
    for (const v of vecs) titleVecs.push(v);
    process.stdout.write(`  ${Math.min(i + BATCH, titles.length)}/${titles.length}\r`);
  }
  console.log("");

  // Compute similarities
  const results = testable.map((entry, i) => {
    const allowSim = cosine(titleVecs[i], allowVec);
    const denySim = cosine(titleVecs[i], denyVec);
    return { ...entry, title: titles[i], allowSim, denySim, spread: allowSim - denySim };
  });

  // Try multiple thresholds to find the best one
  const thresholds = THRESHOLD_ARG
    ? [THRESHOLD_ARG]
    : [-0.05, 0.0, 0.02, 0.05, 0.08, 0.10, 0.12, 0.15, 0.20];

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  EMBEDDING JUDGE EVAL — AI Research Grove");
  console.log("══════════════════════════════════════════════════════════════\n");

  console.log("Strategy: allow if (allow_similarity - deny_similarity) > threshold\n");
  console.log("threshold | precision | recall | f1     | TP  | FP  | FN  | TN  ");
  console.log("----------|-----------|--------|--------|-----|-----|-----|-----");

  let bestF1 = 0;
  let bestThreshold = 0;

  for (const threshold of thresholds) {
    let tp = 0, fp = 0, fn = 0, tn = 0;

    for (const r of results) {
      const predicted = r.spread > threshold ? "allow" : "deny";
      const actual = r.label === "safe-ai" ? "allow" : "deny"; // safe-general treated as deny for AI grove

      if (predicted === "allow" && actual === "allow") tp++;
      else if (predicted === "allow" && actual === "deny") fp++;
      else if (predicted === "deny" && actual === "allow") fn++;
      else tn++;
    }

    const precision = tp / (tp + fp) || 0;
    const recall = tp / (tp + fn) || 0;
    const f1 = 2 * precision * recall / (precision + recall) || 0;

    const marker = THRESHOLD_ARG ? " ←" : (f1 > bestF1 ? " ←best" : "");
    console.log(
      `${threshold.toFixed(2).padStart(9)} | ${(precision * 100).toFixed(1).padStart(9)}% | ${(recall * 100).toFixed(1).padStart(6)}% | ${f1.toFixed(3).padStart(6)} | ${String(tp).padStart(3)} | ${String(fp).padStart(3)} | ${String(fn).padStart(3)} | ${String(tn).padStart(3)}${marker}`
    );

    if (f1 > bestF1) {
      bestF1 = f1;
      bestThreshold = threshold;
    }
  }

  // Show errors at best threshold
  console.log(`\n── Errors at best threshold (${bestThreshold.toFixed(2)}) ──\n`);

  const errors: { type: string; title: string; label: string; spread: number }[] = [];
  for (const r of results) {
    const predicted = r.spread > bestThreshold ? "allow" : "deny";
    const actual = r.label === "safe-ai" ? "allow" : "deny";

    if (predicted !== actual) {
      errors.push({
        type: predicted === "allow" ? "FALSE POSITIVE (leaked sensitive)" : "FALSE NEGATIVE (blocked safe)",
        title: r.title,
        label: r.label,
        spread: r.spread,
      });
    }
  }

  // Sort: false positives first (they're worse), then by spread
  errors.sort((a, b) => {
    if (a.type.includes("POSITIVE") && !b.type.includes("POSITIVE")) return -1;
    if (!a.type.includes("POSITIVE") && b.type.includes("POSITIVE")) return 1;
    return Math.abs(a.spread) - Math.abs(b.spread);
  });

  for (const e of errors.slice(0, 30)) {
    console.log(`  ${e.type}`);
    console.log(`    "${e.title}" (label: ${e.label}, spread: ${e.spread.toFixed(3)})`);
  }
  if (errors.length > 30) console.log(`  ... and ${errors.length - 30} more`);

  console.log(`\nTotal errors: ${errors.length} / ${testable.length}`);
  console.log(`  False positives (leaked): ${errors.filter((e) => e.type.includes("POSITIVE")).length}`);
  console.log(`  False negatives (blocked): ${errors.filter((e) => e.type.includes("NEGATIVE")).length}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
