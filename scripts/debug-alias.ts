#!/usr/bin/env tsx
import { hybridSearch } from "../src/hybrid-search.js";

async function main() {
  const queries = [
    "how to stop overthinking everything",
    "feeling like a fraud at work",
    "what makes a product defensible",
    "how to stop analyzing and just do it",
  ];

  for (const q of queries) {
    console.log(`\n=== ${q} ===`);
    const r = await hybridSearch(q, 5);
    for (const x of r) {
      console.log(`  ${x.rrf_score.toFixed(4)} ${x.title} [${x.sources}]`);
    }
  }
}
main();
