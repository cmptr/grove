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
  created_at: string;
  last_login_at: string | null;
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

  return { id, username, email, role, created_at: new Date().toISOString(), last_login_at: null };
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
