/**
 * Graph health — read-side query helpers for the `graph_health` and
 * `graph_health_flags` tables.
 *
 * The metrics snapshot + score are written by the monitoring cron (P13-1/P13-2);
 * this module exposes the shapes the admin REST layer returns and the small
 * helpers that back those endpoints.
 */

import { getDb } from "./db.js";

export interface GraphHealthMetrics {
  total_notes: number;
  total_links: number;
  link_density: number;
  orphan_count: number;
  orphan_rate: number;
  broken_link_count: number;
  embedding_coverage: number;
  stale_embedding_count: number;
  missing_frontmatter: number;
  duplicate_candidates: number;
  growth_velocity_7d: number;
  growth_velocity_30d: number;
  avg_links_per_note: number;
  cluster_count: number;
  largest_cluster_pct: number;
}

export interface HealthSnapshot {
  id: string;
  measured_at: string;
  score: number;
  metrics: GraphHealthMetrics;
}

export interface HealthFlag {
  id: string;
  flag_type: string;
  source_path: string | null;
  target_path: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
  resolved_at: string | null;
}

interface HealthRow {
  id: string;
  measured_at: string;
  score: number;
  metrics: string;
}

interface FlagRow {
  id: string;
  flag_type: string;
  source_path: string | null;
  target_path: string | null;
  details: string | null;
  created_at: string;
  resolved_at: string | null;
}

function hydrateSnapshot(row: HealthRow): HealthSnapshot {
  return {
    id: row.id,
    measured_at: row.measured_at,
    score: row.score,
    metrics: JSON.parse(row.metrics) as GraphHealthMetrics,
  };
}

function hydrateFlag(row: FlagRow): HealthFlag {
  return {
    id: row.id,
    flag_type: row.flag_type,
    source_path: row.source_path,
    target_path: row.target_path,
    details: row.details ? (JSON.parse(row.details) as Record<string, unknown>) : null,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  };
}

/** Return the most recent health snapshot, or null if none has been recorded. */
export function getCurrentHealth(): HealthSnapshot | null {
  const db = getDb();
  const row = db
    .prepare("SELECT id, measured_at, score, metrics FROM graph_health ORDER BY measured_at DESC LIMIT 1")
    .get() as HealthRow | undefined;
  return row ? hydrateSnapshot(row) : null;
}

/**
 * Return health snapshots from the last `days` days, oldest first.
 * Default window is 30 days; clamped to [1, 365].
 */
export function getHealthHistory(days = 30): HealthSnapshot[] {
  const db = getDb();
  const window = Math.min(365, Math.max(1, Math.floor(days)));
  const rows = db
    .prepare(
      `SELECT id, measured_at, score, metrics
         FROM graph_health
        WHERE measured_at >= datetime('now', ? )
        ORDER BY measured_at ASC`,
    )
    .all(`-${window} days`) as HealthRow[];
  return rows.map(hydrateSnapshot);
}

/** Return unresolved flags, most recent first. */
export function getUnresolvedFlags(): HealthFlag[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, flag_type, source_path, target_path, details, created_at, resolved_at
         FROM graph_health_flags
        WHERE resolved_at IS NULL
        ORDER BY created_at DESC`,
    )
    .all() as FlagRow[];
  return rows.map(hydrateFlag);
}

/**
 * Mark a flag as resolved. Returns true if a row was updated, false if the
 * flag did not exist or was already resolved.
 */
export function resolveFlag(id: string): boolean {
  const db = getDb();
  const result = db
    .prepare("UPDATE graph_health_flags SET resolved_at = datetime('now') WHERE id = ? AND resolved_at IS NULL")
    .run(id);
  return result.changes > 0;
}
