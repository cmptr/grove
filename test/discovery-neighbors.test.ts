import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  findNeighbors,
  type VectorSearchFn,
  type VectorSearchResult,
} from "../src/discovery-neighbors.js";
import {
  getDb,
  createSchema,
  closeDb,
  resetDb,
  getDiscoveryResults,
  dismissDiscoveryResult,
  clearUndismissedResults,
  insertDiscoveryResult,
  type DiscoveryResultRow,
} from "../src/db.js";

// ── Helpers ─────────────────────────────────────────────────────────

function writeNote(dir: string, relPath: string, content: string): void {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

/** Build a mock search function that returns pre-defined results. */
function mockSearch(results: VectorSearchResult[]): VectorSearchFn {
  return async (_query: string, _n: number) => results;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("discovery-neighbors", () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-neighbors-test-"));
    vaultDir = join(tempDir, "vault");
    mkdirSync(vaultDir, { recursive: true });
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    resetDb();
    createSchema();
  });

  afterEach(() => {
    closeDb();
    delete process.env.GROVE_DB_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("surfaces semantically similar notes", async () => {
    writeNote(vaultDir, "Resources/Concepts/transformers.md", `---
title: Transformer Architecture
---

The transformer model uses self-attention mechanisms for sequence processing.
`);

    const search = mockSearch([
      { vault_path: "resources/concepts/attention-mechanisms.md", score: 0.78 },
      { vault_path: "resources/concepts/bert.md", score: 0.65 },
      { vault_path: "resources/concepts/rnns.md", score: 0.52 },
    ]);

    const results = await findNeighbors(
      "Resources/Concepts/transformers.md",
      vaultDir,
      search,
    );

    expect(results).toHaveLength(3);
    expect(results[0].target_path).toBe(
      "resources/concepts/attention-mechanisms.md",
    );
    expect(results[0].similarity).toBe(0.78);
    expect(results[0].relationship).toBe("semantic neighbor");

    // Verify persisted in DB
    const rows = getDiscoveryResults("Resources/Concepts/transformers.md");
    expect(rows).toHaveLength(3);
  });

  it("excludes already-linked notes", async () => {
    writeNote(vaultDir, "Resources/Concepts/transformers.md", `---
title: Transformer Architecture
---

Related to [[Attention Mechanisms]] and [[BERT]].
`);

    const search = mockSearch([
      { vault_path: "resources/concepts/attention-mechanisms.md", score: 0.78 },
      { vault_path: "resources/concepts/bert.md", score: 0.65 },
      { vault_path: "resources/concepts/rnns.md", score: 0.52 },
    ]);

    const results = await findNeighbors(
      "Resources/Concepts/transformers.md",
      vaultDir,
      search,
    );

    // Attention Mechanisms and BERT are linked — only RNNs should remain
    expect(results).toHaveLength(1);
    expect(results[0].target_path).toBe("resources/concepts/rnns.md");
  });

  it("excludes the source note itself", async () => {
    writeNote(vaultDir, "note.md", "Some content about testing.");

    const search = mockSearch([
      { vault_path: "note.md", score: 1.0 },
      { vault_path: "other.md", score: 0.6 },
    ]);

    const results = await findNeighbors("note.md", vaultDir, search);
    expect(results).toHaveLength(1);
    expect(results[0].target_path).toBe("other.md");
  });

  it("filters results below minimum similarity threshold", async () => {
    writeNote(vaultDir, "note.md", "Some content.");

    const search = mockSearch([
      { vault_path: "high.md", score: 0.8 },
      { vault_path: "low.md", score: 0.1 },
    ]);

    const results = await findNeighbors("note.md", vaultDir, search, {
      minSimilarity: 0.5,
    });
    expect(results).toHaveLength(1);
    expect(results[0].target_path).toBe("high.md");
  });

  it("classifies high-similarity results as potential duplicates", async () => {
    writeNote(vaultDir, "note.md", "Some content.");

    const search = mockSearch([
      { vault_path: "almost-same.md", score: 0.92 },
      { vault_path: "related.md", score: 0.55 },
    ]);

    const results = await findNeighbors("note.md", vaultDir, search);
    expect(results[0].relationship).toBe("potential duplicate");
    expect(results[1].relationship).toBe("semantic neighbor");
  });

  it("respects limit option", async () => {
    writeNote(vaultDir, "note.md", "Some content.");

    const search = mockSearch([
      { vault_path: "a.md", score: 0.8 },
      { vault_path: "b.md", score: 0.7 },
      { vault_path: "c.md", score: 0.6 },
      { vault_path: "d.md", score: 0.5 },
    ]);

    const results = await findNeighbors("note.md", vaultDir, search, {
      limit: 2,
    });
    expect(results).toHaveLength(2);
  });

  it("re-processing clears old undismissed results", async () => {
    writeNote(vaultDir, "note.md", "Some content.");

    const search1 = mockSearch([
      { vault_path: "old-neighbor.md", score: 0.7 },
    ]);
    await findNeighbors("note.md", vaultDir, search1);
    expect(getDiscoveryResults("note.md")).toHaveLength(1);

    // Re-process with different results
    const search2 = mockSearch([
      { vault_path: "new-neighbor.md", score: 0.65 },
    ]);
    await findNeighbors("note.md", vaultDir, search2);

    const rows = getDiscoveryResults("note.md");
    expect(rows).toHaveLength(1);
    expect(rows[0].target_path).toBe("new-neighbor.md");
  });

  it("preserves dismissed results when re-processing", async () => {
    writeNote(vaultDir, "note.md", "Some content.");

    const search = mockSearch([
      { vault_path: "neighbor.md", score: 0.7 },
    ]);
    const results = await findNeighbors("note.md", vaultDir, search);
    dismissDiscoveryResult(results[0].id);

    // Re-process — dismissed result should survive, new result added
    const search2 = mockSearch([
      { vault_path: "new-neighbor.md", score: 0.65 },
    ]);
    await findNeighbors("note.md", vaultDir, search2);

    const rows = getDiscoveryResults("note.md");
    expect(rows).toHaveLength(2);
    const dismissed = rows.find((r) => r.target_path === "neighbor.md");
    expect(dismissed).toBeDefined();
    expect(dismissed!.dismissed_at).not.toBeNull();
  });

  it("handles notes with pipe-style wikilinks", async () => {
    writeNote(vaultDir, "note.md", `See [[Attention Mechanisms|attention]] for details.`);

    const search = mockSearch([
      { vault_path: "resources/concepts/attention-mechanisms.md", score: 0.75 },
      { vault_path: "resources/concepts/rnns.md", score: 0.55 },
    ]);

    const results = await findNeighbors("note.md", vaultDir, search);
    // Attention Mechanisms is linked via pipe syntax — should be excluded
    expect(results).toHaveLength(1);
    expect(results[0].target_path).toBe("resources/concepts/rnns.md");
  });

  it("uses filename stem as title when no frontmatter", async () => {
    writeNote(vaultDir, "my-cool-note.md", "Just some content, no frontmatter.");

    let capturedQuery = "";
    const search: VectorSearchFn = async (query, _n) => {
      capturedQuery = query;
      return [];
    };

    await findNeighbors("my-cool-note.md", vaultDir, search);
    expect(capturedQuery).toContain("my cool note");
  });

  it("returns empty array when search returns no candidates", async () => {
    writeNote(vaultDir, "note.md", "Lone note.");
    const search = mockSearch([]);
    const results = await findNeighbors("note.md", vaultDir, search);
    expect(results).toHaveLength(0);
    expect(getDiscoveryResults("note.md")).toHaveLength(0);
  });
});

describe("discovery_results DB helpers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-results-db-test-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    resetDb();
    createSchema();
  });

  afterEach(() => {
    closeDb();
    delete process.env.GROVE_DB_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("insertDiscoveryResult stores a row", () => {
    insertDiscoveryResult("r1", "a.md", "b.md", 0.75, "semantic neighbor");
    const rows = getDiscoveryResults("a.md");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("r1");
    expect(rows[0].similarity).toBe(0.75);
    expect(rows[0].relationship).toBe("semantic neighbor");
    expect(rows[0].dismissed_at).toBeNull();
  });

  it("getDiscoveryResults without source returns all rows", () => {
    insertDiscoveryResult("r1", "a.md", "b.md", 0.75, "semantic neighbor");
    insertDiscoveryResult("r2", "c.md", "d.md", 0.60, "semantic neighbor");
    const rows = getDiscoveryResults();
    expect(rows).toHaveLength(2);
  });

  it("dismissDiscoveryResult sets dismissed_at", () => {
    insertDiscoveryResult("r1", "a.md", "b.md", 0.75, "semantic neighbor");
    dismissDiscoveryResult("r1");
    const rows = getDiscoveryResults("a.md");
    expect(rows[0].dismissed_at).not.toBeNull();
  });

  it("clearUndismissedResults keeps dismissed rows", () => {
    insertDiscoveryResult("r1", "a.md", "b.md", 0.75, "semantic neighbor");
    insertDiscoveryResult("r2", "a.md", "c.md", 0.60, "semantic neighbor");
    dismissDiscoveryResult("r1");
    clearUndismissedResults("a.md");
    const rows = getDiscoveryResults("a.md");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("r1");
  });

  it("clearUndismissedResults scoped to source_path", () => {
    insertDiscoveryResult("r1", "a.md", "b.md", 0.75, "semantic neighbor");
    insertDiscoveryResult("r2", "x.md", "y.md", 0.60, "semantic neighbor");
    clearUndismissedResults("a.md");
    expect(getDiscoveryResults("a.md")).toHaveLength(0);
    expect(getDiscoveryResults("x.md")).toHaveLength(1);
  });
});
