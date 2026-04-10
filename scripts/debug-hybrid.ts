#!/usr/bin/env tsx
import { titleSearch, bm25Search, vectorSearch, hybridSearch } from "../src/hybrid-search.js";

const queries = [
  { q: "AI coding tools and developer experience", expected: "AI Coding Agents" },
  { q: "building a personal AI that knows you", expected: "AI Personal Assistant Agents" },
  { q: "what makes a product defensible", expected: "Competitive Moats" },
];

async function main() {
  for (const { q, expected } of queries) {
    console.log(`\n=== ${q} ===`);
    console.log(`Expected: ${expected}`);

    try {
      const t = titleSearch(q, 10);
      console.log(`title (${t.length} results):`, t.map(r => r.title).join(", ") || "(none)");
    } catch (e: any) {
      console.log("title ERROR:", e.message);
    }

    try {
      const b = bm25Search(q, 10);
      console.log(`bm25 (${b.length} results):`, b.slice(0, 5).map(r => r.title).join(", ") || "(none)");
    } catch (e: any) {
      console.log("bm25 ERROR:", e.message);
    }

    try {
      const h = await hybridSearch(q, 5);
      console.log("hybrid:", h.map(r => `${r.title} [${r.sources}]`).join(", "));
    } catch (e: any) {
      console.log("hybrid error:", e.message);
    }
  }
}
main();
