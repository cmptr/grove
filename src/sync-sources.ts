/**
 * Sync archived Source notes to Grove.
 *
 * Reads .md files from a local archive directory, parses their frontmatter,
 * compares against what's already on the vault, and pushes new/updated notes
 * via the write_note MCP tool.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { parseNote } from "./notes-validate.js";

export interface SourceNote {
  /** Relative vault path, e.g. "Sources/2026-04-02 @karpathy - LLM Knowledge Bases.md" */
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

export interface SyncPlan {
  toCreate: SourceNote[];
  toUpdate: SourceNote[];
  skipped: string[];
}

/**
 * Read all .md source files from a local directory.
 * Skips non-.md files, subdirectories, and index files.
 */
export function readArchiveSources(dir: string): SourceNote[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const notes: SourceNote[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (entry.name === "X Bookmarks.md") continue; // skip index

    const raw = readFileSync(join(dir, entry.name), "utf-8");
    const { frontmatter, content } = parseNote(raw);

    // Ensure source type for notes that predate the type field
    if (!frontmatter.type) frontmatter.type = "source";

    // Ensure x-bookmark tag
    const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
    if (!tags.includes("x-bookmark")) tags.push("x-bookmark");
    frontmatter.tags = tags;

    notes.push({
      path: `Sources/${entry.name}`,
      frontmatter,
      content,
    });
  }

  return notes;
}

/**
 * Diff local sources against existing vault paths to produce a sync plan.
 */
export function planSync(
  local: SourceNote[],
  existingPaths: Set<string>,
): SyncPlan {
  const toCreate: SourceNote[] = [];
  const toUpdate: SourceNote[] = [];
  const skipped: string[] = [];

  for (const note of local) {
    if (!note.frontmatter.author || !note.frontmatter.url) {
      skipped.push(`${note.path} (missing required fields: author, url)`);
      continue;
    }

    if (existingPaths.has(note.path)) {
      skipped.push(note.path);
    } else {
      toCreate.push(note);
    }
  }

  return { toCreate, toUpdate, skipped };
}
