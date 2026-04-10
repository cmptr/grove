#!/usr/bin/env tsx
import Database from "better-sqlite3";
import { homedir } from "node:os";

const db = new Database(`${homedir()}/.cache/qmd/index.sqlite`, { readonly: true });

const query = "AI coding tools and developer experience";
const sanitized = query.replace(/['"]/g, "").trim();

const stopwords = new Set(["the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "from", "is", "it", "that", "this", "was", "are", "be", "has", "had", "not", "you", "how", "what", "who", "why", "when", "do", "does", "can"]);
const terms = sanitized.split(/\s+/).filter(t => t.length >= 2 && !stopwords.has(t.toLowerCase()));
const titleQuery = terms.map(t => `title:${t}`).join(" OR ");

console.log("Terms:", terms);
console.log("Title query:", titleQuery);

// Test without the JOIN
console.log("\n--- Without JOIN ---");
const r1 = db.prepare(
  `SELECT filepath, title, rank FROM documents_fts WHERE documents_fts MATCH ? ORDER BY rank LIMIT 5`
).all(titleQuery) as any[];
for (const r of r1) console.log(`  ${r.rank.toFixed(2)} ${r.filepath} → ${r.title}`);

// Test with the JOIN
console.log("\n--- With JOIN ---");
const r2 = db.prepare(
  `SELECT f.filepath, f.title, rank
   FROM documents_fts f
   JOIN documents d ON d.path = f.filepath AND d.active = 1
   WHERE documents_fts MATCH ?
   ORDER BY rank
   LIMIT 5`
).all(titleQuery) as any[];
for (const r of r2) console.log(`  ${r.rank.toFixed(2)} ${r.filepath} → ${r.title}`);

if (r2.length === 0) {
  // Check if filepath exists in documents table
  console.log("\n--- Checking documents table ---");
  for (const r of r1.slice(0, 3)) {
    const doc = db.prepare("SELECT path, active FROM documents WHERE path = ?").get(r.filepath) as any;
    console.log(`  ${r.filepath}: doc=${JSON.stringify(doc)}`);
    // Also try partial match
    const like = db.prepare("SELECT path, active FROM documents WHERE path LIKE ?").all(`%${r.title.slice(0, 20)}%`) as any[];
    console.log(`    LIKE matches: ${like.map((d: any) => `${d.path} (active=${d.active})`).join(", ")}`);
  }
}

db.close();
