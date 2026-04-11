import { describe, it, expect } from "vitest";
import { stripWikilinks } from "../src/hybrid-search.js";

// ── RRF Fusion logic ────────────────────────────────────────────────
// Re-implement the pure rrfFuse function for testing since it's not exported.

interface SearchResult {
  file: string;
  title: string;
  score: number;
  snippet: string;
  docid?: string;
}

interface HybridResult {
  file: string;
  title: string;
  rrf_score: number;
  snippet: string;
  sources: string[];
}

function rrfFuse(
  lists: { results: SearchResult[]; weight: number; label: string }[],
  n: number,
  k = 60,
): HybridResult[] {
  const scores: Record<string, number> = {};
  const meta: Record<string, SearchResult> = {};
  const sources: Record<string, Set<string>> = {};

  for (const { results, weight, label } of lists) {
    for (let rank = 0; rank < results.length; rank++) {
      const key = results[rank].file;
      scores[key] = (scores[key] ?? 0) + weight / (k + rank);
      if (!meta[key]) meta[key] = results[rank];
      if (!sources[key]) sources[key] = new Set();
      sources[key].add(label);
    }
  }

  return Object.keys(scores)
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, n)
    .map((key) => ({
      file: meta[key].file,
      title: meta[key].title,
      rrf_score: Math.round(scores[key] * 10000) / 10000,
      snippet: meta[key].snippet,
      sources: [...(sources[key] ?? [])],
    }));
}

describe("rrfFuse", () => {
  const bm25Results: SearchResult[] = [
    { file: "a.md", title: "A", score: 0.9, snippet: "snippet a" },
    { file: "b.md", title: "B", score: 0.7, snippet: "snippet b" },
    { file: "c.md", title: "C", score: 0.5, snippet: "snippet c" },
  ];

  const vecResults: SearchResult[] = [
    { file: "b.md", title: "B", score: 0.95, snippet: "snippet b vec" },
    { file: "d.md", title: "D", score: 0.8, snippet: "snippet d" },
    { file: "a.md", title: "A", score: 0.6, snippet: "snippet a vec" },
  ];

  it("fuses two result lists with RRF scoring", () => {
    const fused = rrfFuse(
      [
        { results: bm25Results, weight: 1.2, label: "bm25" },
        { results: vecResults, weight: 1.0, label: "vector" },
      ],
      10,
    );

    // Both A and B appear in both lists, so they should score higher
    const files = fused.map((r) => r.file);
    expect(files).toContain("a.md");
    expect(files).toContain("b.md");

    // A and B should have both sources
    const aResult = fused.find((r) => r.file === "a.md")!;
    expect(aResult.sources).toContain("bm25");
    expect(aResult.sources).toContain("vector");
  });

  it("respects limit parameter", () => {
    const fused = rrfFuse(
      [
        { results: bm25Results, weight: 1.0, label: "bm25" },
        { results: vecResults, weight: 1.0, label: "vector" },
      ],
      2,
    );
    expect(fused).toHaveLength(2);
  });

  it("handles single list (BM25-only fallback)", () => {
    const fused = rrfFuse(
      [{ results: bm25Results, weight: 1.0, label: "bm25" }],
      10,
    );
    expect(fused).toHaveLength(3);
    expect(fused.every((r) => r.sources.includes("bm25"))).toBe(true);
    expect(fused.every((r) => r.sources.length === 1)).toBe(true);
  });

  it("items in both lists score higher than single-list items", () => {
    const fused = rrfFuse(
      [
        { results: bm25Results, weight: 1.0, label: "bm25" },
        { results: vecResults, weight: 1.0, label: "vector" },
      ],
      10,
    );

    // B is rank 0 in vec, rank 1 in bm25 => highest dual score
    // D only appears in vec => lower score
    const bScore = fused.find((r) => r.file === "b.md")!.rrf_score;
    const dScore = fused.find((r) => r.file === "d.md")!.rrf_score;
    expect(bScore).toBeGreaterThan(dScore);
  });

  it("applies weight correctly", () => {
    // Same results, but heavily weight bm25
    const heavyBm25 = rrfFuse(
      [
        { results: bm25Results, weight: 10.0, label: "bm25" },
        { results: vecResults, weight: 0.1, label: "vector" },
      ],
      10,
    );

    // With heavy bm25 weight, A (rank 0 in bm25) should come first
    expect(heavyBm25[0].file).toBe("a.md");
  });

  it("returns empty for empty input", () => {
    const fused = rrfFuse([], 10);
    expect(fused).toEqual([]);
  });
});

// ── stripWikilinks ──────────────────────────────────────────────────

describe("stripWikilinks", () => {
  it("strips simple wikilinks", () => {
    expect(stripWikilinks("about [[Anxiety]]")).toBe("about Anxiety");
  });

  it("strips piped wikilinks using display text", () => {
    expect(stripWikilinks("[[Anxiety & Fear Management|Anxiety]]")).toBe("Anxiety");
  });

  it("strips multiple wikilinks in one string", () => {
    expect(stripWikilinks("[[Mila]] and [[Nina]]")).toBe("Mila and Nina");
  });

  it("handles mixed piped and simple wikilinks", () => {
    expect(stripWikilinks("Organizational Changes and [[Anxiety & Fear Management|Anxiety]]"))
      .toBe("Organizational Changes and Anxiety");
  });

  it("returns string unchanged when no wikilinks", () => {
    expect(stripWikilinks("plain text")).toBe("plain text");
  });

  it("handles empty string", () => {
    expect(stripWikilinks("")).toBe("");
  });
});

// ── formatResults ───────────────────────────────────────────────────

describe("formatResults", () => {
  // Re-implement the pure formatResults function
  function formatResults(results: HybridResult[]): string {
    if (results.length === 0) return "No results found.";
    return results
      .map(
        (r) =>
          `**${r.title}** (${r.file}, score: ${r.rrf_score})\n${r.snippet ?? ""}`,
      )
      .join("\n\n---\n\n");
  }

  it("returns 'No results found.' for empty array", () => {
    expect(formatResults([])).toBe("No results found.");
  });

  it("formats results with title, file, score, and snippet", () => {
    const results: HybridResult[] = [
      { file: "test.md", title: "Test", rrf_score: 0.5, snippet: "hello", sources: ["bm25"] },
    ];
    const output = formatResults(results);
    expect(output).toContain("**Test**");
    expect(output).toContain("test.md");
    expect(output).toContain("0.5");
    expect(output).toContain("hello");
  });

  it("separates multiple results with ---", () => {
    const results: HybridResult[] = [
      { file: "a.md", title: "A", rrf_score: 0.9, snippet: "aaa", sources: ["bm25"] },
      { file: "b.md", title: "B", rrf_score: 0.8, snippet: "bbb", sources: ["vector"] },
    ];
    const output = formatResults(results);
    expect(output).toContain("---");
    expect(output.split("---")).toHaveLength(2);
  });
});
