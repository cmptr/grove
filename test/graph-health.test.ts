import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

// ── Isolate DB before importing anything that touches it ─────────────
const SUITE_DIR = mkdtempSync(join(tmpdir(), "grove-health-suite-"));
const TEST_DB_PATH = join(SUITE_DIR, "grove.db");
process.env.GROVE_DB_PATH = TEST_DB_PATH;
// Point QMD index at a path that does not exist so index-health stays
// in its "unavailable" branch (embedding_coverage = -1).
process.env.QMD_INDEX = join(SUITE_DIR, "no-index.sqlite");

import { getDb, resetDb, createSchema } from "../src/db.js";
import {
  computeHealthMetrics,
  calculateHealthScore,
  storeHealthSnapshot,
  getLatestHealthSnapshot,
  getHealthHistory,
  getPriorSnapshotWithin,
  detectAlerts,
  runHealthCheck,
  DEFAULT_ALERT_THRESHOLDS,
  type GraphHealthMetrics,
} from "../src/graph-health.js";

// ── Helpers ──────────────────────────────────────────────────────────

function baseMetrics(overrides: Partial<GraphHealthMetrics> = {}): GraphHealthMetrics {
  return {
    total_notes: 100,
    total_links: 250,
    link_density: 2.5,
    orphan_count: 2,
    orphan_rate: 0.02,
    broken_link_count: 0,
    embedding_coverage: 0.98,
    stale_embedding_count: 0,
    missing_frontmatter: 0,
    duplicate_candidates: 0,
    growth_velocity_7d: 3,
    growth_velocity_30d: 12,
    avg_links_per_note: 2.5,
    cluster_count: 1,
    largest_cluster_pct: 1,
    ...overrides,
  };
}

function writeNote(
  vault: string,
  rel: string,
  fm: { type?: string; tags?: string[] } | null,
  body: string,
): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  let content = "";
  if (fm) {
    const tags = fm.tags && fm.tags.length > 0 ? `\ntags: [${fm.tags.join(", ")}]` : "";
    const type = fm.type ? `\ntype: ${fm.type}` : "";
    content = `---${type}${tags}\n---\n`;
  }
  writeFileSync(abs, content + body);
}

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-health-vault-"));
  // Initialise as an empty git repo so growth velocity path doesn't
  // error out. Commit nothing — velocity should be 0.
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  } catch {
    // If git isn't available the module degrades to zero velocity.
  }
  return dir;
}

// ── Setup ────────────────────────────────────────────────────────────

beforeEach(() => {
  resetDb();
  createSchema();
  // Wipe between tests — resetDb only drops the handle, not the file.
  getDb().exec("DELETE FROM graph_health");
});

afterEach(() => {
  resetDb();
});

// ── calculateHealthScore ─────────────────────────────────────────────

describe("calculateHealthScore", () => {
  it("awards maximum score to a pristine vault", () => {
    const m = baseMetrics();
    expect(calculateHealthScore(m)).toBe(100);
  });

  it("penalises high orphan rate", () => {
    const perfect = calculateHealthScore(baseMetrics());
    const withOrphans = calculateHealthScore(baseMetrics({ orphan_rate: 0.2 }));
    expect(withOrphans).toBeLessThan(perfect);
    expect(withOrphans).toBe(perfect - 20);
  });

  it("partially credits orphan rate between 5% and 10%", () => {
    const m = baseMetrics({ orphan_rate: 0.07 });
    const perfect = calculateHealthScore(baseMetrics());
    expect(calculateHealthScore(m)).toBe(perfect - 10);
  });

  it("penalises broken links", () => {
    const perfect = calculateHealthScore(baseMetrics());
    expect(
      calculateHealthScore(baseMetrics({ broken_link_count: 50 })),
    ).toBe(perfect - 20);
    expect(
      calculateHealthScore(baseMetrics({ broken_link_count: 3 })),
    ).toBe(perfect - 10);
  });

  it("penalises low embedding coverage", () => {
    const perfect = calculateHealthScore(baseMetrics());
    expect(
      calculateHealthScore(baseMetrics({ embedding_coverage: 0.5 })),
    ).toBe(perfect - 20);
    expect(
      calculateHealthScore(baseMetrics({ embedding_coverage: 0.9 })),
    ).toBe(perfect - 10);
  });

  it("treats unknown embedding coverage (-1) as non-penalising", () => {
    const m = baseMetrics({ embedding_coverage: -1 });
    expect(calculateHealthScore(m)).toBe(100);
  });

  it("penalises stagnant vaults", () => {
    const perfect = calculateHealthScore(baseMetrics());
    const stagnant = calculateHealthScore(
      baseMetrics({ growth_velocity_7d: 0, growth_velocity_30d: 0 }),
    );
    expect(stagnant).toBe(perfect - 10);
  });

  it("clamps to 0-100", () => {
    const terrible = calculateHealthScore(
      baseMetrics({
        orphan_rate: 0.8,
        broken_link_count: 200,
        embedding_coverage: 0.1,
        link_density: 0.1,
        growth_velocity_7d: 0,
        growth_velocity_30d: 0,
        missing_frontmatter: 300,
      }),
    );
    expect(terrible).toBeGreaterThanOrEqual(0);
    expect(terrible).toBeLessThanOrEqual(100);
  });
});

// ── computeHealthMetrics ─────────────────────────────────────────────

describe("computeHealthMetrics", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeVault();
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("counts notes, links, and orphans against a fixture vault", async () => {
    writeNote(vault, "Alpha.md", { type: "concept", tags: ["a"] }, "Links to [[Beta]] and [[Gamma]].");
    writeNote(vault, "Beta.md", { type: "concept", tags: ["b"] }, "Back to [[Alpha]].");
    writeNote(vault, "Gamma.md", { type: "concept", tags: ["g"] }, "No outbound links.");
    writeNote(vault, "Lonely.md", { type: "concept", tags: ["x"] }, "No links at all.");

    const m = await computeHealthMetrics(vault);

    expect(m.total_notes).toBe(4);
    // Alpha→Beta, Alpha→Gamma, Beta→Alpha = 3 real edges
    expect(m.total_links).toBe(3);
    // Lonely has no in/out — one orphan
    expect(m.orphan_count).toBe(1);
    expect(m.orphan_rate).toBeCloseTo(0.25, 4);
    expect(m.broken_link_count).toBe(0);
    // All four notes have full frontmatter
    expect(m.missing_frontmatter).toBe(0);
    // Two clusters: {Alpha,Beta,Gamma} and {Lonely}
    expect(m.cluster_count).toBe(2);
    expect(m.largest_cluster_pct).toBeCloseTo(0.75, 4);
    // Index unavailable — coverage reported as -1
    expect(m.embedding_coverage).toBe(-1);
  });

  it("counts broken wikilinks to non-existent notes", async () => {
    writeNote(vault, "A.md", { type: "concept", tags: ["a"] }, "See [[Missing]] and [[AlsoMissing]].");
    writeNote(vault, "B.md", { type: "concept", tags: ["b"] }, "See [[A]].");

    const m = await computeHealthMetrics(vault);
    expect(m.broken_link_count).toBe(2);
    expect(m.total_links).toBe(1);
  });

  it("flags notes missing required frontmatter", async () => {
    writeNote(vault, "Complete.md", { type: "concept", tags: ["ok"] }, "Good.");
    writeNote(vault, "NoType.md", { tags: ["ok"] }, "No type.");
    writeNote(vault, "NoTags.md", { type: "concept" }, "No tags.");
    writeNote(vault, "Bare.md", null, "No frontmatter at all.");

    const m = await computeHealthMetrics(vault);
    expect(m.total_notes).toBe(4);
    expect(m.missing_frontmatter).toBe(3);
  });

  it("returns zeros for an empty vault without throwing", async () => {
    const m = await computeHealthMetrics(vault);
    expect(m.total_notes).toBe(0);
    expect(m.total_links).toBe(0);
    expect(m.orphan_count).toBe(0);
    expect(m.orphan_rate).toBe(0);
    expect(m.largest_cluster_pct).toBe(0);
  });
});

// ── Persistence ──────────────────────────────────────────────────────

describe("storeHealthSnapshot", () => {
  it("persists a snapshot and returns it via getLatest", () => {
    const m = baseMetrics();
    const stored = storeHealthSnapshot(m, calculateHealthScore(m));

    const latest = getLatestHealthSnapshot();
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(stored.id);
    expect(latest!.score).toBe(stored.score);
    expect(latest!.metrics.total_notes).toBe(m.total_notes);
    expect(latest!.measured_at).toBe(stored.measured_at);
  });

  it("returns most-recent-first history", () => {
    storeHealthSnapshot(baseMetrics(), 90, "2026-04-18T00:00:00.000Z");
    storeHealthSnapshot(baseMetrics(), 95, "2026-04-19T00:00:00.000Z");
    storeHealthSnapshot(baseMetrics(), 100, "2026-04-20T00:00:00.000Z");

    const history = getHealthHistory(10);
    expect(history).toHaveLength(3);
    expect(history[0].score).toBe(100);
    expect(history[2].score).toBe(90);
  });

  it("finds the prior snapshot within a 24h window", () => {
    storeHealthSnapshot(baseMetrics(), 80, "2026-04-18T00:00:00.000Z"); // out of window
    storeHealthSnapshot(baseMetrics(), 90, "2026-04-19T06:00:00.000Z"); // in window
    const prior = getPriorSnapshotWithin("2026-04-20T00:00:00.000Z");
    expect(prior).not.toBeNull();
    expect(prior!.score).toBe(90);
  });
});

// ── detectAlerts ─────────────────────────────────────────────────────

describe("detectAlerts", () => {
  it("fires no alerts on a healthy vault with no prior", () => {
    const m = baseMetrics();
    const alerts = detectAlerts(m, 100, null);
    expect(alerts).toHaveLength(0);
  });

  it("fires score_drop when the 24h delta exceeds the threshold", () => {
    const m = baseMetrics();
    const prior = {
      id: "health_prior",
      measured_at: "2026-04-19T00:00:00.000Z",
      metrics: m,
      score: 95,
    };
    const alerts = detectAlerts(m, 80, prior);
    expect(alerts.map((a) => a.type)).toContain("score_drop");
  });

  it("does not fire score_drop for small fluctuations", () => {
    const m = baseMetrics();
    const prior = {
      id: "health_prior",
      measured_at: "2026-04-19T00:00:00.000Z",
      metrics: m,
      score: 95,
    };
    const alerts = detectAlerts(m, 90, prior);
    expect(alerts.map((a) => a.type)).not.toContain("score_drop");
  });

  it("fires orphan_rate when rate exceeds 15%", () => {
    const alerts = detectAlerts(
      baseMetrics({ orphan_rate: 0.25 }),
      100,
      null,
    );
    expect(alerts.map((a) => a.type)).toContain("orphan_rate");
  });

  it("fires broken_links when count exceeds threshold", () => {
    const alerts = detectAlerts(
      baseMetrics({ broken_link_count: 25 }),
      100,
      null,
    );
    expect(alerts.map((a) => a.type)).toContain("broken_links");
  });

  it("fires embedding_coverage when coverage drops below 80%", () => {
    const alerts = detectAlerts(
      baseMetrics({ embedding_coverage: 0.6 }),
      100,
      null,
    );
    expect(alerts.map((a) => a.type)).toContain("embedding_coverage");
  });

  it("suppresses embedding_coverage alerts when coverage is unknown (-1)", () => {
    const alerts = detectAlerts(
      baseMetrics({ embedding_coverage: -1 }),
      100,
      null,
    );
    expect(alerts.map((a) => a.type)).not.toContain("embedding_coverage");
  });

  it("respects custom thresholds", () => {
    const m = baseMetrics({ broken_link_count: 5 });
    const alerts = detectAlerts(m, 100, null, {
      ...DEFAULT_ALERT_THRESHOLDS,
      broken_links: 3,
    });
    expect(alerts.map((a) => a.type)).toContain("broken_links");
  });
});

// ── runHealthCheck (end-to-end) ──────────────────────────────────────

describe("runHealthCheck", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeVault();
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("stores a snapshot and returns alerts for a degraded vault", async () => {
    // Stage an existing baseline that we'll diverge from.
    storeHealthSnapshot(
      baseMetrics(),
      95,
      new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    );

    // Build a deliberately bad fixture: many broken links, many orphans.
    writeNote(vault, "Hub.md", { type: "concept", tags: ["x"] }, "No real targets.");
    for (let i = 0; i < 30; i++) {
      writeNote(vault, `Orphan${i}.md`, { type: "concept", tags: ["x"] }, "Alone.");
    }
    // 25 broken links out of Hub → trips broken_links threshold
    const hub = join(vault, "Hub.md");
    const manyBroken = Array.from({ length: 25 }, (_, i) => `[[Missing${i}]]`).join(" ");
    writeFileSync(hub, `---\ntype: concept\ntags: [x]\n---\n${manyBroken}`);

    const alerts: string[] = [];
    const result = await runHealthCheck(vault, {
      onAlert: (a) => alerts.push(a.type),
    });

    expect(result.snapshot.metrics.broken_link_count).toBe(25);
    expect(result.snapshot.metrics.orphan_count).toBeGreaterThan(20);
    expect(alerts).toContain("broken_links");
    expect(alerts).toContain("orphan_rate");

    // Persisted
    const latest = getLatestHealthSnapshot();
    expect(latest!.id).toBe(result.snapshot.id);
  });

  it("does not alert on a healthy vault", async () => {
    writeNote(vault, "A.md", { type: "concept", tags: ["a"] }, "[[B]] [[C]]");
    writeNote(vault, "B.md", { type: "concept", tags: ["b"] }, "[[A]] [[C]]");
    writeNote(vault, "C.md", { type: "concept", tags: ["c"] }, "[[A]] [[B]]");

    const alerts: string[] = [];
    const result = await runHealthCheck(vault, {
      onAlert: (a) => alerts.push(a.type),
    });

    expect(result.snapshot.metrics.broken_link_count).toBe(0);
    expect(result.snapshot.metrics.orphan_count).toBe(0);
    expect(alerts).toHaveLength(0);
  });
});
