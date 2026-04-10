/**
 * One-time script: Add 'ai' tag to AI-related concept notes that are missing it.
 * This makes them visible on the AI trail for demo purposes.
 *
 * Run: npx tsx scripts/add-ai-tags.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseNote, serializeNote } from "../src/notes-validate.js";
import { gitCommit } from "../src/vault-ops.js";

const VAULT_PATH = process.env.GROVE_VAULT ?? join(homedir(), "life");

const NOTES_TO_TAG = [
  "Resources/Concepts/AI Agent Memory & Context.md",
  "Resources/Concepts/AI Coding Agents.md",
  "Resources/Concepts/AI Self-Improvement Loops.md",
  "Resources/Concepts/AI Tutoring & Education.md",
  "Resources/Concepts/AI Frontend Design.md",
  "Resources/Concepts/AI Image Generation.md",
  "Resources/Concepts/AI Personal Assistant Agents.md",
  "Resources/Concepts/Agentic Web.md",
  "Resources/Concepts/Agentic AI Foundation.md",
  "Resources/Concepts/Agent Memory Governance.md",
  "Resources/Concepts/Multi-Agent Architecture.md",
  "Resources/Concepts/Claude Code Workflows.md",
  "Resources/Concepts/MCP (Model Context Protocol).md",
  "Resources/Concepts/MCP Servers & Tools.md",
  "Resources/Concepts/Personal AI Workflows.md",
  "Resources/Concepts/RAG Architecture.md",
  "Resources/Concepts/Prompt Engineering.md",
  "Resources/Concepts/Taste Embedding.md",
  "Resources/Concepts/Generative Art & Creative Coding.md",
  "Resources/Concepts/Generative UI.md",
  "Resources/Concepts/AI-Native UX.md",
  "Resources/Concepts/AI-Native Product Teams.md",
  "Resources/Concepts/Personal Knowledge Management.md",
  "Resources/Concepts/LLMs As Simulators.md",
  "Resources/Concepts/Knowledge Graphs as Design Spaces.md",
  "Resources/Concepts/Vertical AI Startups.md",
  "Resources/Concepts/JSON Prompt Architecture.md",
  "Resources/Concepts/Local-First AI Tools.md",
  "Resources/Concepts/Single vs Multi-Agent Tradeoffs.md",
  "Resources/Concepts/AI Strategic Planning.md",
];

let updated = 0;
let skipped = 0;

for (const relPath of NOTES_TO_TAG) {
  const absPath = join(VAULT_PATH, relPath);

  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch {
    console.log(`  SKIP (not found): ${relPath}`);
    skipped++;
    continue;
  }

  const { frontmatter, content } = parseNote(raw);

  // Get current tags
  const tags: string[] = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter((t): t is string => typeof t === "string")
    : typeof frontmatter.tags === "string"
    ? [frontmatter.tags]
    : [];

  if (tags.includes("ai")) {
    console.log(`  SKIP (already tagged): ${relPath}`);
    skipped++;
    continue;
  }

  // Add 'ai' tag
  tags.push("ai");
  frontmatter.tags = tags;

  // Serialize and write
  const serialized = serializeNote(frontmatter, content);
  writeFileSync(absPath, serialized, "utf-8");

  // Git commit
  try {
    await gitCommit(VAULT_PATH, relPath, `grove (tag-updater): add ai tag to ${relPath.split("/").pop()?.replace(".md", "")}`);
  } catch (err) {
    console.error(`  WARN: commit failed for ${relPath}: ${(err as Error).message}`);
  }

  updated++;
  console.log(`  UPDATED: ${relPath}`);
}

console.log(`\nDone: ${updated} updated, ${skipped} skipped`);
