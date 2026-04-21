/**
 * Share-a-note links for Grove.
 *
 * Creates short-lived, scoped share links that resolve to a micro-trail:
 * the shared note + its depth-1 inbound backlinks. Outbound links are
 * excluded to prevent leaking sensitive content.
 */

import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { getUserById } from "./users.js";

export interface SharedLink {
  id: string;
  note_path: string;
  created_by: string;
  expires_at: string;
  max_views: number | null;
  view_count: number;
  last_accessed_at: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface CreateShareResult {
  id: string;
  url: string;
  expires_at: string;
}

function generateShareId(): string {
  return "sh_" + randomBytes(6).toString("hex");
}

/**
 * Create a share link for a note.
 *
 * `max_views`: `undefined` → default 100; `null` → unlimited; `number` → cap.
 * Default TTL is 7 days.
 */
export function createShareLink(
  notePath: string,
  createdBy: string,
  baseUrl: string,
  opts?: { ttl_days?: number; max_views?: number | null },
): CreateShareResult {
  const db = getDb();
  const id = generateShareId();
  const now = new Date();
  const ttlDays = opts?.ttl_days ?? 7;
  const maxViews = opts?.max_views === undefined ? 100 : opts.max_views;
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

  db.prepare(
    "INSERT INTO shared_links (id, note_path, created_by, expires_at, max_views, view_count, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
  ).run(id, notePath, createdBy, expiresAt.toISOString(), maxViews, now.toISOString());

  const owner = getUserById(createdBy);
  const ownerHandle = owner?.username ?? "unknown";
  const wwwBase = baseUrl.replace("api.grove.md", "grove.md");
  const url = `${wwwBase}/@${ownerHandle}/s/${id}`;

  return { id, url, expires_at: expiresAt.toISOString() };
}

/**
 * Resolve a share link by ID. Returns null if not found, expired, revoked,
 * or view-capped. Increments view_count and stamps last_accessed_at on
 * successful resolve.
 */
export function resolveShareLink(id: string): SharedLink | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM shared_links WHERE id = ?").get(id) as SharedLink | undefined;
  if (!row) return null;

  if (row.revoked_at !== null) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  if (row.max_views !== null && row.view_count >= row.max_views) return null;

  const nowIso = new Date().toISOString();
  db.prepare(
    "UPDATE shared_links SET view_count = view_count + 1, last_accessed_at = ? WHERE id = ?",
  ).run(nowIso, id);

  return { ...row, view_count: row.view_count + 1, last_accessed_at: nowIso };
}

/**
 * Get a share link without incrementing views (for admin inspection).
 */
export function getShareLink(id: string): SharedLink | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM shared_links WHERE id = ?").get(id) as SharedLink | undefined;
  return row ?? null;
}

/**
 * List share links for a user.
 *
 * By default returns only active links (not revoked, not expired, not view-capped).
 * Pass `include_expired: true` to include revoked/expired/capped rows.
 * Pass `note_path` to filter to a specific note.
 */
export function listShareLinks(
  userId: string,
  opts?: { note_path?: string; include_expired?: boolean },
): SharedLink[] {
  const db = getDb();
  const clauses: string[] = ["created_by = ?"];
  const params: unknown[] = [userId];

  if (opts?.note_path) {
    clauses.push("note_path = ?");
    params.push(opts.note_path);
  }

  if (!opts?.include_expired) {
    clauses.push("revoked_at IS NULL");
    // Compare via datetime() so ISO `T` format and SQLite `datetime('now')` space
    // format are normalized — lexical compare alone would mis-order them.
    clauses.push("datetime(expires_at) > datetime('now')");
    clauses.push("(max_views IS NULL OR view_count < max_views)");
  }

  return db
    .prepare(`SELECT * FROM shared_links WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`)
    .all(...params) as SharedLink[];
}

/**
 * Soft-revoke a share link. Stamps `revoked_by` + `revoked_at` and sets
 * `expires_at = now()` so resolve returns null immediately. Returns true if a
 * row was updated (false if already revoked or non-existent).
 */
export function revokeShareLink(id: string, revokedBy: string): boolean {
  const db = getDb();
  const result = db
    .prepare(
      "UPDATE shared_links SET expires_at = datetime('now'), revoked_by = ?, revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL",
    )
    .run(revokedBy, id);
  return result.changes > 0;
}

/**
 * Hard-delete a share link. Prefer `revokeShareLink` for audit-preserving removal.
 */
export function deleteShareLink(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM shared_links WHERE id = ?").run(id);
  return result.changes > 0;
}
