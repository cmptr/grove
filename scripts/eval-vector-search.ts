#!/usr/bin/env tsx
/**
 * Vector Search Evaluation Harness
 *
 * Measures precision@5, recall@5, and MRR for BM25, vector, and hybrid search
 * against a labeled set of test cases.
 *
 * Usage:
 *   npx tsx scripts/eval-vector-search.ts
 */

import { bm25Search, vectorSearch, hybridSearch } from "../src/hybrid-search.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface TestCase {
  query: string;
  expected: string[]; // expected titles that should appear in top-5
}

interface CaseResult {
  query: string;
  expected: string[];
  bm25Titles: string[];
  vecTitles: string[];
  hybridTitles: string[];
  bm25Hit: boolean;
  vecHit: boolean;
  hybridHit: boolean;
  bm25Rr: number; // reciprocal rank (0 if not found)
  vecRr: number;
  hybridRr: number;
  vecError?: string;
}

// ── Test cases ─────────────────────────────────────────────────────────────

const TEST_CASES: TestCase[] = [
  // Concept retrieval (semantic)
  {
    query: "what is high agency and how to develop it",
    expected: ["Agency & High Agency"],
  },
  {
    query: "parametric design systems",
    expected: ["Parametric Design"],
  },
  {
    query: "how AI agents manage memory and context",
    expected: ["AI Agent Memory & Context"],
  },
  {
    query: "dealing with anxiety and fear",
    expected: ["Anxiety & Fear Management"],
  },
  {
    query: "building habits that stick",
    expected: ["Atomic Habits"],
  },
  {
    query: "how to do financial planning for buying a house",
    expected: ["Financial Planning & House Purchase"],
  },
  {
    query: "context window engineering for LLMs",
    expected: ["Context Engineering"],
  },
  {
    query: "AI coding tools and developer experience",
    expected: ["AI Coding Agents", "Claude Code Workflows"],
  },
  {
    query: "emotional regulation techniques",
    expected: ["Emotional Regulation"],
  },
  {
    query: "design automation and generative systems",
    expected: ["Design Automation & Generative Design"],
  },

  // Cross-type retrieval
  {
    query: "shrimp pasta recipe with miso",
    expected: ["Brown Butter Miso Shrimp Angel Hair"],
  },
  {
    query: "quick peanut noodle recipe",
    expected: ["15-Minute Peanut Noodles"],
  },
  {
    query: "beef stew recipe",
    expected: ["Baba Beef Stew Patsy Edition", "Baba's Beef Stew (via DD)"],
  },

  // Semantic gap (harder — query terms don't match title)
  {
    query: "how to stop overthinking everything",
    expected: ["Anxiety & Fear Management", "OCD & Pure O"],
  },
  {
    query: "building a personal AI that knows you",
    expected: ["AI Personal Assistant Agents", "AI Agent Memory & Context"],
  },
  {
    query: "what makes a product defensible",
    expected: ["Competitive Moats"],
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns reciprocal rank of the first expected title found in results.
 * Returns 0 if none found in top-5.
 */
function reciprocalRank(titles: string[], expected: string[]): number {
  for (let i = 0; i < Math.min(titles.length, 5); i++) {
    if (expected.some((e) => titles[i].toLowerCase() === e.toLowerCase())) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Returns true if any expected title appears in the top-5 results.
 */
function hasHit(titles: string[], expected: string[]): boolean {
  return reciprocalRank(titles, expected) > 0;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function pct(n: number, total: number): string {
  return ((n / total) * 100).toFixed(1) + "%";
}

function fmt(n: number): string {
  return n.toFixed(2);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function runEval(): Promise<void> {
  console.log("\nVector Search Eval");
  console.log("==================\n");

  const results: CaseResult[] = [];
  let vecDown = false;
  let vecErrorMsg = "";

  for (const tc of TEST_CASES) {
    process.stdout.write(`  Running: ${truncate(tc.query, 55)}... `);

    // BM25
    let bm25Titles: string[] = [];
    try {
      const bm25Results = await bm25Search(tc.query, 5);
      bm25Titles = bm25Results.map((r) => r.title);
    } catch (err) {
      bm25Titles = [];
    }

    // Vector
    let vecTitles: string[] = [];
    let vecError: string | undefined;
    try {
      const vecResults = await vectorSearch(tc.query, 5);
      vecTitles = vecResults.map((r) => r.title);
    } catch (err) {
      vecError = err instanceof Error ? err.message : String(err);
      vecDown = true;
      vecErrorMsg = vecError;
    }

    // Hybrid
    let hybridTitles: string[] = [];
    try {
      const hybridResults = await hybridSearch(tc.query, 5);
      hybridTitles = hybridResults.map((r) => r.title);
    } catch (err) {
      hybridTitles = bm25Titles; // fallback
    }

    const result: CaseResult = {
      query: tc.query,
      expected: tc.expected,
      bm25Titles,
      vecTitles,
      hybridTitles,
      bm25Hit: hasHit(bm25Titles, tc.expected),
      vecHit: hasHit(vecTitles, tc.expected),
      hybridHit: hasHit(hybridTitles, tc.expected),
      bm25Rr: reciprocalRank(bm25Titles, tc.expected),
      vecRr: reciprocalRank(vecTitles, tc.expected),
      hybridRr: reciprocalRank(hybridTitles, tc.expected),
      vecError,
    };

    results.push(result);
    console.log("done");
  }

  if (vecDown) {
    console.log(`\n  ⚠  Vector search unavailable: ${vecErrorMsg}`);
    console.log("     Vector and hybrid metrics reflect BM25-only fallback.\n");
  }

  // ── Results table ──────────────────────────────────────────────────────

  const COL_Q = 46;
  const COL_B = 6;
  const COL_V = 6;
  const COL_H = 8;
  const COL_E = 0; // expected — flexible

  const header =
    "Query".padEnd(COL_Q) +
    "| BM25 " +
    "| Vec  " +
    "| Hybrid " +
    "| Expected";
  const divider =
    "-".repeat(COL_Q) +
    "|------" +
    "|------" +
    "|--------" +
    "|--------";

  console.log(header);
  console.log(divider);

  for (const r of results) {
    const q = truncate(r.query, COL_Q - 1).padEnd(COL_Q);
    const b = (r.bm25Hit ? "✓" : "✗").padEnd(COL_B);
    const v = (r.vecHit ? "✓" : vecDown ? "-" : "✗").padEnd(COL_V);
    const h = (r.hybridHit ? "✓" : "✗").padEnd(COL_H);
    const e = r.expected.join(", ");
    console.log(`${q}| ${b}| ${v}| ${h}| ${e}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────

  const n = results.length;
  const bm25Hits = results.filter((r) => r.bm25Hit).length;
  const vecHits = results.filter((r) => r.vecHit).length;
  const hybridHits = results.filter((r) => r.hybridHit).length;

  const bm25Mrr = results.reduce((sum, r) => sum + r.bm25Rr, 0) / n;
  const vecMrr = results.reduce((sum, r) => sum + r.vecRr, 0) / n;
  const hybridMrr = results.reduce((sum, r) => sum + r.hybridRr, 0) / n;

  console.log("\nSummary:");
  console.log(
    `  BM25:   ${bm25Hits}/${n} (${pct(bm25Hits, n)}) precision@5, MRR: ${fmt(bm25Mrr)}`
  );
  if (vecDown) {
    console.log(`  Vector: unavailable (TEI down)`);
  } else {
    console.log(
      `  Vector:  ${vecHits}/${n} (${pct(vecHits, n)}) precision@5, MRR: ${fmt(vecMrr)}`
    );
  }
  console.log(
    `  Hybrid: ${hybridHits}/${n} (${pct(hybridHits, n)}) precision@5, MRR: ${fmt(hybridMrr)}`
  );

  // ── Misses detail ──────────────────────────────────────────────────────

  const bm25Misses = results.filter((r) => !r.bm25Hit);
  const hybridMisses = results.filter((r) => !r.hybridHit);

  if (hybridMisses.length > 0) {
    console.log("\nHybrid misses (top-5 returned):");
    for (const r of hybridMisses) {
      console.log(`  "${truncate(r.query, 50)}"`);
      console.log(`    Expected: ${r.expected.join(", ")}`);
      console.log(
        `    Got:      ${r.hybridTitles.slice(0, 5).join(", ") || "(none)"}`
      );
    }
  }

  console.log("");
}

runEval().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
