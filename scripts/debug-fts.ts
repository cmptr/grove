#!/usr/bin/env tsx
import Database from "better-sqlite3";
import { homedir } from "node:os";

const db = new Database(`${homedir()}/.cache/qmd/index.sqlite`, { readonly: true });

// Test various FTS5 queries
const tests = [
  // What titleSearch would generate
  'title:AI OR title:coding OR title:tools OR title:developer OR title:experience',
  // Simpler
  'title:AI OR title:coding',
  'title:coding',
  'AI coding',
  'coding tools',
  // BM25 OR
  'AI OR coding OR tools OR developer OR experience',
  // What about the sanitization?
  'product OR defensible',
  'personal OR AI OR knows',
];

for (const q of tests) {
  try {
    const r = db.prepare(
      "SELECT title, rank FROM documents_fts WHERE documents_fts MATCH ? ORDER BY rank LIMIT 3"
    ).all(q) as any[];
    console.log(`"${q}": ${r.length} results`);
    for (const row of r) console.log(`  ${row.rank.toFixed(2)} ${row.title}`);
  } catch (e: any) {
    console.log(`"${q}": ERROR: ${e.message}`);
  }
  console.log();
}

db.close();
