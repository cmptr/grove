#!/usr/bin/env tsx
import { titleSearch, bm25Search, vectorSearch, hybridSearch } from "../src/hybrid-search.js";

const queries = [
  { q: "AI coding tools and developer experience", expected: "AI Coding Agents" },
  { q: "building a personal AI that knows you", expected: "AI Personal Assistant Agents" },
  { q: "how to stop overthinking everything", expected: "Anxiety & Fear Management" },
  { q: "what makes a product defensible", expected: "Competitive Moats" },
  { q: "context window engineering for LLMs", expected: "Context Engineering" },
];

async function main() {
  for (const { q, expected } of queries) {
    console.log(`\n=== ${q} ===`);
    console.log(`Expected: ${expected}`);

    const t = titleSearch(q, 5);
    console.log("title:", t.map(r => r.title).join(", ") || "(none)");

    const b = bm25Search(q, 5);
    console.log("bm25:", b.map(r => r.title).join(", ") || "(none)");

    try {
      const h = await hybridSearch(q, 5);
      console.log("hybrid:", h.map(r => `${r.title} [${r.sources}]`).join(", "));
    } catch (e: any) {
      console.log("hybrid error:", e.message);
    }
  }
}
main();
