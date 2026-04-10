/**
 * Trail configuration and filtering for Grove.
 *
 * A trail is: a name + topic boundaries (tags, types, paths) + permission level + API key.
 * Consumers connect via MCP and see only what the trail allows.
 *
 * Config stored in ~/.grove/trails.json.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { createKey } from "./keys.js";

const TRAILS_PATH = join(homedir(), ".grove", "trails.json");

// ── Trail config schema ───────────────────────────────────────────

export interface TrailConfig {
  id: string;
  name: string;
  description: string;
  key_id: string;        // associated API key
  enabled: boolean;
  created_at: string;
  // Scope filters — ALL must pass (AND logic)
  allow_tags: string[];   // note must have at least one of these tags
  deny_tags: string[];    // note must NOT have any of these tags
  allow_types: string[];  // note type must be one of these (empty = all)
  deny_types: string[];   // note type must NOT be one of these
  allow_paths: string[];  // note path must start with one of these prefixes (empty = all)
  deny_paths: string[];   // note path must NOT start with any of these prefixes
  // Rate limits
  rate_limit_reads: number;   // per minute
  rate_limit_writes: number;  // per minute (0 = no writes)
}

// ── CRUD operations ───────────────────────────────────────────────

export function loadTrails(): TrailConfig[] {
  if (!existsSync(TRAILS_PATH)) return [];
  try { return JSON.parse(readFileSync(TRAILS_PATH, "utf-8")); } catch { return []; }
}

export function saveTrails(trails: TrailConfig[]): void {
  writeFileSync(TRAILS_PATH, JSON.stringify(trails, null, 2), { mode: 0o600 });
}

export function generateTrailId(): string {
  return "trail_" + randomBytes(4).toString("hex");
}

export function createTrail(opts: {
  name: string;
  description?: string;
  allow_tags?: string[];
  deny_tags?: string[];
  allow_types?: string[];
  deny_types?: string[];
  allow_paths?: string[];
  deny_paths?: string[];
  rate_limit_reads?: number;
  rate_limit_writes?: number;
}): { trail: TrailConfig; token: string } {
  const trails = loadTrails();

  // Create a read-only API key for this trail
  const keyResult = createKey(`trail:${opts.name}`, ["read"], "life");

  const trail: TrailConfig = {
    id: generateTrailId(),
    name: opts.name,
    description: opts.description ?? "",
    key_id: keyResult.id,
    enabled: true,
    created_at: new Date().toISOString(),
    allow_tags: opts.allow_tags ?? [],
    deny_tags: opts.deny_tags ?? [],
    allow_types: opts.allow_types ?? [],
    deny_types: opts.deny_types ?? [],
    allow_paths: opts.allow_paths ?? [],
    deny_paths: opts.deny_paths ?? [],
    rate_limit_reads: opts.rate_limit_reads ?? 60,
    rate_limit_writes: opts.rate_limit_writes ?? 0,
  };

  trails.push(trail);
  saveTrails(trails);
  return { trail, token: keyResult.token };
}

export function disableTrail(id: string): boolean {
  const trails = loadTrails();
  const trail = trails.find((t) => t.id === id);
  if (!trail) return false;
  trail.enabled = false;
  saveTrails(trails);
  return true;
}

export function deleteTrail(id: string): boolean {
  const trails = loadTrails();
  const idx = trails.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  trails.splice(idx, 1);
  saveTrails(trails);
  return true;
}

export function resolveTrail(keyId: string): TrailConfig | null {
  const trails = loadTrails();
  return trails.find((t) => t.key_id === keyId && t.enabled) ?? null;
}

// ── Trail filtering ───────────────────────────────────────────────

export interface NoteMetadata {
  path: string;
  tags?: string[];
  type?: string;
  private?: boolean;
}

/**
 * Check if a note is visible under a trail's scope.
 * Returns true if the note passes ALL filters.
 */
export function filterByTrail(trail: TrailConfig, note: NoteMetadata): boolean {
  // Private notes are always excluded from trails (strict boolean check)
  if (note.private === true) return false;

  // Path allow filter
  if (trail.allow_paths.length > 0) {
    const pathAllowed = trail.allow_paths.some((prefix) => note.path.startsWith(prefix));
    if (!pathAllowed) return false;
  }

  // Path deny filter
  if (trail.deny_paths.length > 0) {
    const pathDenied = trail.deny_paths.some((prefix) => note.path.startsWith(prefix));
    if (pathDenied) return false;
  }

  // Type allow filter
  if (trail.allow_types.length > 0) {
    if (!note.type || !trail.allow_types.includes(note.type)) return false;
  }

  // Type deny filter
  if (trail.deny_types.length > 0) {
    if (note.type && trail.deny_types.includes(note.type)) return false;
  }

  // Tag allow filter — note must have at least one matching tag
  if (trail.allow_tags.length > 0) {
    const noteTags = note.tags ?? [];
    const hasMatch = trail.allow_tags.some((tag) => noteTags.includes(tag));
    if (!hasMatch) return false;
  }

  // Tag deny filter
  if (trail.deny_tags.length > 0) {
    const noteTags = note.tags ?? [];
    const hasDenied = trail.deny_tags.some((tag) => noteTags.includes(tag));
    if (hasDenied) return false;
  }

  return true;
}

/**
 * Check if a trail allows writes to a given path.
 * Trail must have rate_limit_writes > 0 and path must be within allow_paths.
 */
export function trailAllowsWrite(trail: TrailConfig, path: string): boolean {
  if (trail.rate_limit_writes <= 0) return false;

  // If allow_paths specified, path must match
  if (trail.allow_paths.length > 0) {
    return trail.allow_paths.some((prefix) => path.startsWith(prefix));
  }

  // If deny_paths specified, path must not match
  if (trail.deny_paths.length > 0) {
    return !trail.deny_paths.some((prefix) => path.startsWith(prefix));
  }

  return true;
}

// ── Trail audit logging ───────────────────────────────────────────

import { structuredLog } from "./logger.js";

export function logTrailAccess(
  rid: string,
  trailId: string,
  trailName: string,
  tool: string,
  totalResults: number,
  filteredResults: number,
): void {
  structuredLog({
    ts: new Date().toISOString(),
    rid,
    level: "info",
    msg: "trail.access",
    trail_id: trailId,
    trail_name: trailName,
    tool,
    total_count: totalResults,
    filtered_count: filteredResults,
  });
}
