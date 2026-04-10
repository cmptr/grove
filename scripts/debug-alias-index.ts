#!/usr/bin/env tsx
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

// Replicate the alias index building logic
const QMD_INDEX = `${homedir()}/.cache/qmd/index.sqlite`;

const vec0Paths = [
  `${homedir()}/.npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-linux-x64/vec0`,
  `/usr/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-linux-x64/vec0`,
];
let vec0Path: string | null = null;
for (const base of vec0Paths) {
  if (existsSync(`${base}.so`) || existsSync(`${base}.dylib`)) { vec0Path = base; break; }
}

const db = new Database(QMD_INDEX, { readonly: true });
if (vec0Path) db.loadExtension(vec0Path);

const rows = db
  .prepare(
    `SELECT d.path, d.title, d.collection, c.doc
     FROM documents d
     JOIN content c ON d.hash = c.hash
     WHERE d.active = 1 AND c.doc LIKE '%aliases:%'`
  )
  .all() as { path: string; title: string; collection: string; doc: string }[];

console.log(`${rows.length} docs with aliases`);

// Check a specific one
const anxiety = rows.find(r => r.title === "Anxiety & Fear Management");
if (anxiety) {
  const fm = anxiety.doc.match(/^---\n([\s\S]*?)\n---/);
  console.log("\nAnxiety FM match:", fm ? "yes" : "no");
  if (fm) {
    console.log("FM block:", fm[1].slice(0, 300));
    const aliasMatch = fm[1].match(/aliases:\s*\n((?:\s+-\s+"[^"]*"\n?)*)/);
    console.log("Alias match:", aliasMatch ? aliasMatch[1] : "NONE");

    // Try alternative patterns
    const aliasMatch2 = fm[1].match(/aliases:\s*\n((?:\s+-\s+.*\n?)*)/);
    console.log("Alias match (relaxed):", aliasMatch2 ? aliasMatch2[1] : "NONE");
  }
} else {
  console.log("Anxiety note not found in query");
}

// Check what aliases look like in raw YAML
const sample = rows.slice(0, 3);
for (const r of sample) {
  const fm = r.doc.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const lines = fm[1].split("\n").filter(l => l.includes("alias") || l.startsWith("  -"));
    console.log(`\n${r.title}:`);
    for (const l of lines) console.log(`  ${l}`);
  }
}

db.close();
