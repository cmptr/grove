/**
 * Sync archived Source notes to Grove.
 *
 * Reads .md files from a local archive directory, parses their frontmatter,
 * compares against what's already on the vault, and pushes new/updated notes
 * via the write_note MCP tool.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { parseNote, serializeNote } from "./notes-validate.js";

/**
 * Normalize a markdown note through Grove's YAML serializer.
 * Returns the normalized string. If already normalized, returns the input unchanged.
 * This prevents quoting divergence (e.g., "Foo" vs Foo) that causes merge conflicts
 * when notes are written by different tools but synced to the same git remote.
 */
export function normalizeNote(raw: string): string {
  const { frontmatter, content } = parseNote(raw);
  if (Object.keys(frontmatter).length === 0) return raw; // no frontmatter to normalize
  return serializeNote(frontmatter, content);
}

/**
 * Normalize all .md files in a directory in-place.
 * Returns count of files that were changed.
 */
export function normalizeDir(dir: string): { changed: string[]; total: number } {
  const entries = readdirSync(dir, { withFileTypes: true });
  const changed: string[] = [];
  let total = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    total++;

    const filePath = join(dir, entry.name);
    const raw = readFileSync(filePath, "utf-8");
    const normalized = normalizeNote(raw);

    if (raw !== normalized) {
      writeFileSync(filePath, normalized, "utf-8");
      changed.push(entry.name);
    }
  }

  return { changed, total };
}

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

    // Backfill type for legacy notes that predate the type field
    if (!frontmatter.type) frontmatter.type = "source";

    // Ensure at least one tag exists
    const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
    if (tags.length === 0) tags.push("x-bookmark");
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
    if (existingPaths.has(note.path)) {
      skipped.push(note.path);
    } else {
      toCreate.push(note);
    }
  }

  return { toCreate, toUpdate, skipped };
}
