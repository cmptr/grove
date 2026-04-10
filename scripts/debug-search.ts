#!/usr/bin/env tsx
/**
 * Debug search results for the eval misses.
 */
import Database from "better-sqlite3";
import { homedir } from "node:os";

const db = new Database(`${homedir()}/.cache/qmd/index.sqlite`, { readonly: true });

// Check FTS5 schema
const info = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'documents_fts'").get() as any;
console.log("FTS schema:", info?.sql);

// Test title-scoped FTS5 searches
const tests = [
  "title:coding OR title:agents",
  "title:competitive OR title:moats",
  "title:anxiety OR title:fear",
  "title:context OR title:engineering",
  "title:personal AND title:AI",
];

for (const q of tests) {
  try {
    const r = db.prepare(
      "SELECT title, rank FROM documents_fts WHERE documents_fts MATCH ? ORDER BY rank LIMIT 5"
    ).all(q) as any[];
    console.log(`\n${q}:`);
    for (const row of r) console.log(`  ${row.rank.toFixed(4)} ${row.title}`);
  } catch (e: any) {
    console.log(`\n${q}: ERROR ${e.message}`);
  }
}

// Also test: does a simple documents table search find these by path?
console.log("\n\n=== Direct title LIKE search ===");
const targets = ["Competitive Moats", "Context Engineering", "AI Coding Agents", "Anxiety", "AI Personal Assistant"];
for (const t of targets) {
  const r = db.prepare(
    "SELECT path, title FROM documents WHERE title LIKE ? AND active = 1"
  ).all(`%${t}%`) as any[];
  console.log(`\n"${t}": ${r.length} results`);
  for (const row of r) console.log(`  ${row.path} → ${row.title}`);
}

db.close();
