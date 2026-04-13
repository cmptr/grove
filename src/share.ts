/**
 * Share-a-note links for Grove.
 *
 * Creates short-lived, scoped share links that resolve to a micro-trail:
 * the shared note + its depth-1 inbound backlinks. Outbound links are
 * excluded to prevent leaking sensitive content.
 */

import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";

export interface SharedLink {
  id: string;
  note_path: string;
  created_by: string;
  expires_at: string;
  max_views: number;
  view_count: number;
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
 * Returns the share ID and URL. Default TTL is 7 days, default max views is 100.
 */
export function createShareLink(
  notePath: string,
  createdBy: string,
  baseUrl: string,
  opts?: { ttl_days?: number; max_views?: number },
): CreateShareResult {
  const db = getDb();
  const id = generateShareId();
  const now = new Date();
  const ttlDays = opts?.ttl_days ?? 7;
  const maxViews = opts?.max_views ?? 100;
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

  db.prepare(
    "INSERT INTO shared_links (id, note_path, created_by, expires_at, max_views, view_count, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
  ).run(id, notePath, createdBy, expiresAt.toISOString(), maxViews, now.toISOString());

  // URL points to grove-www /s/<id>
  const wwwBase = baseUrl.replace("api.grove.md", "grove.md");
  const url = `${wwwBase}/s/${id}`;

  return { id, url, expires_at: expiresAt.toISOString() };
}

/**
 * Resolve a share link by ID. Returns null if not found, expired, or exhausted.
 * Increments view_count on successful resolve.
 */
export function resolveShareLink(id: string): SharedLink | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM shared_links WHERE id = ?").get(id) as SharedLink | undefined;
  if (!row) return null;

  // Check expiry
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  // Check view count
  if (row.view_count >= row.max_views) return null;

  // Increment view count
  db.prepare("UPDATE shared_links SET view_count = view_count + 1 WHERE id = ?").run(id);

  return { ...row, view_count: row.view_count + 1 };
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
 * List all share links created by a user.
 */
export function listShareLinks(userId: string): SharedLink[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM shared_links WHERE created_by = ? ORDER BY created_at DESC")
    .all(userId) as SharedLink[];
}

/**
 * Delete a share link.
 */
export function deleteShareLink(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM shared_links WHERE id = ?").run(id);
  return result.changes > 0;
}
