/**
 * User management for Grove.
 */

import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";

export type UserRole = "owner" | "member" | "viewer";

export interface User {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  display_name: string | null;
  created_at: string;
  last_login_at: string | null;
}

/** Update a user's display name. Returns true if the row was updated. */
export function updateUserDisplayName(userId: string, displayName: string): boolean {
  const db = getDb();
  const result = db
    .prepare("UPDATE users SET display_name = ? WHERE id = ?")
    .run(displayName.trim() || null, userId);
  return result.changes > 0;
}

/** List active sessions for a user (for profile page). */
export interface SessionRow {
  id: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  user_agent: string | null;
}
export function listUserSessions(userId: string): SessionRow[] {
  const db = getDb();
  // expires_at is stored as ISO-8601 (…T…Z) but datetime('now') returns a
  // space-separated form. Normalize both sides through datetime() so the
  // comparison is date-aware, not a lexical string compare.
  return db
    .prepare(
      `SELECT id, created_at, last_used_at, expires_at, user_agent
         FROM sessions
        WHERE user_id = ? AND datetime(expires_at) > datetime('now')
        ORDER BY last_used_at DESC NULLS LAST, created_at DESC`,
    )
    .all(userId) as SessionRow[];
}

/** Revoke a single session by id (user-scoped — can only revoke own). */
export function revokeUserSession(userId: string, sessionId: string): boolean {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?")
    .run(sessionId, userId);
  return result.changes > 0;
}

/** Revoke all sessions for a user except the current one. */
export function revokeAllOtherSessions(userId: string, keepSessionId: string): number {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?")
    .run(userId, keepSessionId);
  return result.changes;
}

const RESERVED_USERNAMES = new Set([
  "login", "auth", "settings", "api", "admin", "about",
  "pricing", "help", "docs", "blog", "status", "health",
  "mcp", "v1", "trails", "new", "search",
]);

const USERNAME_RE = /^[a-z0-9][a-z0-9-]{2,30}$/;

export function validateUsername(username: string): { valid: boolean; reason?: string } {
  if (!USERNAME_RE.test(username)) {
    return { valid: false, reason: "Username must be 3-31 chars, lowercase alphanumeric and hyphens, starting with alphanumeric" };
  }
  if (RESERVED_USERNAMES.has(username)) {
    return { valid: false, reason: "Username is reserved" };
  }
  return { valid: true };
}

export function createUser(email: string, username: string, role: UserRole = "viewer"): User {
  const validation = validateUsername(username);
  if (!validation.valid) throw new Error(validation.reason);

  const id = "user_" + randomBytes(4).toString("hex");
  const db = getDb();
  db.prepare(
    "INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)"
  ).run(id, username, email, role);

  return { id, username, email, role, display_name: null, created_at: new Date().toISOString(), last_login_at: null };
}

export function getUserById(id: string): User | null {
  const db = getDb();
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | null;
}

export function getUserByUsername(username: string): User | null {
  const db = getDb();
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as User | null;
}

export function getUserByEmail(email: string): User | null {
  const db = getDb();
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email) as User | null;
}

export function getUserRole(userId: string): UserRole | null {
  const db = getDb();
  const row = db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: UserRole } | undefined;
  return row?.role ?? null;
}

/**
 * Delete a user and all associated data (keys, sessions, trail grants).
 * Cannot delete the owner user.
 */
export function deleteUser(userId: string): boolean {
  const db = getDb();

  const user = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId) as { id: string; role: string } | undefined;
  if (!user) return false;
  if (user.role === "owner") throw new Error("Cannot delete the owner user");

  // Delete trail grants linked to this user's keys
  db.prepare(
    "DELETE FROM trail_grants WHERE grantee_type = 'token' AND grantee_id IN (SELECT id FROM api_keys WHERE user_id = ?)"
  ).run(userId);

  // Delete all API keys
  db.prepare("DELETE FROM api_keys WHERE user_id = ?").run(userId);

  // Delete all sessions
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);

  // Delete the user
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);

  return true;
}

export interface UserWithMeta {
  id: string;
  username: string | null;
  email: string | null;
  role: string;
  created_at: string;
  last_login_at: string | null;
  key_count: number;
  trails: string[];
}

/**
 * List all users with their key counts and trail names.
 */
export function listUsersWithMeta(): UserWithMeta[] {
  const db = getDb();
  const users = db.prepare(
    "SELECT id, username, email, role, created_at, last_login_at FROM users"
  ).all() as { id: string; username: string | null; email: string | null; role: string; created_at: string; last_login_at: string | null }[];

  return users.map((u) => {
    const keyCount = db.prepare(
      "SELECT COUNT(*) as count FROM api_keys WHERE user_id = ?"
    ).get(u.id) as { count: number };

    const trails = db.prepare(
      `SELECT DISTINCT t.name FROM trails t
       JOIN trail_grants tg ON t.id = tg.trail_id
       JOIN api_keys ak ON tg.grantee_id = ak.id AND tg.grantee_type = 'token'
       WHERE ak.user_id = ?`
    ).all(u.id) as { name: string }[];

    return {
      ...u,
      key_count: keyCount.count,
      trails: trails.map((t) => t.name),
    };
  });
}
