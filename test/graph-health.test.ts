import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-graph-health-"));
process.env.GROVE_DB_PATH = join(TEST_DIR, "grove.db");

import { getDb, createSchema, resetDb } from "../src/db.js";
import {
  getCurrentHealth,
  getHealthHistory,
  getUnresolvedFlags,
  resolveFlag,
  type GraphHealthMetrics,
} from "../src/graph-health.js";

function makeMetrics(overrides: Partial<GraphHealthMetrics> = {}): GraphHealthMetrics {
  return {
    total_notes: 100,
    total_links: 250,
    link_density: 2.5,
    orphan_count: 4,
    orphan_rate: 0.04,
    broken_link_count: 1,
    embedding_coverage: 0.96,
    stale_embedding_count: 2,
    missing_frontmatter: 0,
    duplicate_candidates: 1,
    growth_velocity_7d: 5,
    growth_velocity_30d: 18,
    avg_links_per_note: 2.5,
    cluster_count: 3,
    largest_cluster_pct: 0.92,
    ...overrides,
  };
}

function insertSnapshot(id: string, measuredAt: string, score: number, metrics: GraphHealthMetrics): void {
  getDb()
    .prepare("INSERT INTO graph_health (id, measured_at, metrics, score) VALUES (?, ?, ?, ?)")
    .run(id, measuredAt, JSON.stringify(metrics), score);
}

function insertFlag(
  id: string,
  flagType: string,
  opts: {
    source_path?: string;
    target_path?: string;
    details?: Record<string, unknown>;
    created_at?: string;
    resolved_at?: string | null;
  } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO graph_health_flags
        (id, flag_type, source_path, target_path, details, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      flagType,
      opts.source_path ?? null,
      opts.target_path ?? null,
      opts.details ? JSON.stringify(opts.details) : null,
      opts.created_at ?? new Date().toISOString(),
      opts.resolved_at ?? null,
    );
}

describe("graph-health query helpers", () => {
  beforeEach(() => {
    resetDb();
    createSchema();
    const db = getDb();
    db.exec("DELETE FROM graph_health_flags");
    db.exec("DELETE FROM graph_health");
  });

  afterEach(() => {
    resetDb();
  });

  describe("getCurrentHealth", () => {
    it("returns null when no snapshots have been recorded", () => {
      expect(getCurrentHealth()).toBeNull();
    });

    it("returns the most recent snapshot with parsed metrics", () => {
      insertSnapshot("health_01", "2026-04-18T00:00:00Z", 70, makeMetrics({ total_notes: 50 }));
      insertSnapshot("health_02", "2026-04-19T00:00:00Z", 82, makeMetrics({ total_notes: 100 }));
      insertSnapshot("health_03", "2026-04-17T00:00:00Z", 60, makeMetrics({ total_notes: 30 }));

      const current = getCurrentHealth();
      expect(current).not.toBeNull();
      expect(current!.id).toBe("health_02");
      expect(current!.score).toBe(82);
      expect(current!.metrics.total_notes).toBe(100);
      expect(current!.measured_at).toBe("2026-04-19T00:00:00Z");
    });
  });

  describe("getHealthHistory", () => {
    it("returns an empty array when no snapshots exist", () => {
      expect(getHealthHistory(30)).toEqual([]);
    });

    it("returns snapshots within the window, oldest first", () => {
      const now = new Date();
      const iso = (daysAgo: number) =>
        new Date(now.getTime() - daysAgo * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");

      insertSnapshot("h_2", iso(2), 80, makeMetrics());
      insertSnapshot("h_10", iso(10), 75, makeMetrics());
      insertSnapshot("h_45", iso(45), 60, makeMetrics()); // outside 30-day window

      const history = getHealthHistory(30);
      expect(history.map((s) => s.id)).toEqual(["h_10", "h_2"]);
      expect(history[0].metrics.total_notes).toBe(100);
    });

    it("clamps the window to at least 1 day", () => {
      // Subqueries with days=0 would include nothing; ensure it doesn't throw
      const history = getHealthHistory(0);
      expect(history).toEqual([]);
    });
  });

  describe("getUnresolvedFlags", () => {
    it("returns only unresolved flags, most recent first", () => {
      insertFlag("flag_a", "duplicate_candidate", {
        source_path: "a.md",
        target_path: "b.md",
        details: { similarity: 0.87 },
        created_at: "2026-04-15T00:00:00Z",
      });
      insertFlag("flag_b", "long_orphan", {
        source_path: "c.md",
        created_at: "2026-04-18T00:00:00Z",
      });
      insertFlag("flag_c", "duplicate_candidate", {
        source_path: "d.md",
        target_path: "e.md",
        created_at: "2026-04-10T00:00:00Z",
        resolved_at: "2026-04-11T00:00:00Z",
      });

      const flags = getUnresolvedFlags();
      expect(flags.map((f) => f.id)).toEqual(["flag_b", "flag_a"]);
      expect(flags[1].details).toEqual({ similarity: 0.87 });
      expect(flags[0].details).toBeNull();
    });
  });

  describe("resolveFlag", () => {
    it("marks an unresolved flag as resolved and returns true", () => {
      insertFlag("flag_x", "cluster_island", { source_path: "x.md" });
      expect(resolveFlag("flag_x")).toBe(true);

      const row = getDb()
        .prepare("SELECT resolved_at FROM graph_health_flags WHERE id = ?")
        .get("flag_x") as { resolved_at: string | null };
      expect(row.resolved_at).not.toBeNull();

      // The same flag is no longer in the unresolved list
      expect(getUnresolvedFlags().map((f) => f.id)).not.toContain("flag_x");
    });

    it("returns false for a flag that does not exist", () => {
      expect(resolveFlag("flag_missing")).toBe(false);
    });

    it("returns false for a flag that was already resolved", () => {
      insertFlag("flag_y", "duplicate_candidate", {
        source_path: "y.md",
        resolved_at: "2026-04-19T00:00:00Z",
      });
      expect(resolveFlag("flag_y")).toBe(false);
    });
  });
});

// Best-effort cleanup of the temp DB dir
process.on("exit", () => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});
