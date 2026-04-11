/**
 * SQLite database singleton for Grove.
 *
 * Manages schema creation, JSON→SQLite migration, and a shared connection.
 * Database lives at ~/.grove/grove.db with WAL mode and foreign keys enabled.
 */

import Database from "better-sqlite3";
import { existsSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const GROVE_DIR = join(homedir(), ".grove");
const DB_PATH = process.env.GROVE_DB_PATH ?? join(GROVE_DIR, "grove.db");
const KEYS_PATH = join(GROVE_DIR, "keys.json");
const TRAILS_PATH = join(GROVE_DIR, "trails.json");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(GROVE_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/** Close the database connection (for tests/cleanup). */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Reset the module-level singleton (for tests that swap DB_PATH via env). */
export function resetDb(): void {
  closeDb();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  email TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  git_repo_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  storage_bytes INTEGER NOT NULL DEFAULT 0,
  storage_quota_bytes INTEGER NOT NULL DEFAULT 104857600,
  UNIQUE(owner_id, slug)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  vault_id TEXT NOT NULL,
  name TEXT NOT NULL,
  hashed_token TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT 'read,write',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS trails (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trail_grants (
  id TEXT PRIMARY KEY,
  trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  grantee_type TEXT NOT NULL,
  grantee_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS magic_links (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);
`;

export function createSchema(): void {
  const database = getDb();
  database.exec(SCHEMA);
}

/**
 * Migrate from JSON files to SQLite.
 *
 * Idempotent: if grove.db already has data, this is a no-op.
 * Reads keys.json and trails.json, imports them into SQLite in a single
 * transaction, then renames the originals to .migrated.
 */
export function runMigration(): void {
  createSchema();
  const database = getDb();

  // Check if we already have data (migration already ran)
  const keyCount = database.prepare("SELECT COUNT(*) as count FROM api_keys").get() as { count: number };
  if (keyCount.count > 0) return;

  // Check if there's JSON data to migrate
  const hasKeys = existsSync(KEYS_PATH);
  const hasTrails = existsSync(TRAILS_PATH);

  if (!hasKeys && !hasTrails) {
    // No JSON files — fresh install. Create admin user and default vault.
    const adminId = "user_00000000";
    database.prepare(
      "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)"
    ).run(adminId, "admin", "admin@grove.local");
    database.prepare(
      "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)"
    ).run("vault_00000000", adminId, "life", "Life", join(homedir(), "life"));
    return;
  }

  // Migrate inside a transaction
  const migrate = database.transaction(() => {
    // Create admin user
    const adminId = "user_00000000";
    database.prepare(
      "INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)"
    ).run(adminId, "admin", "admin@grove.local");

    // Create default vault
    database.prepare(
      "INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)"
    ).run("vault_00000000", adminId, "life", "Life", join(homedir(), "life"));

    // Import keys
    if (hasKeys) {
      const keys = JSON.parse(readFileSync(KEYS_PATH, "utf-8")) as Array<{
        id: string;
        name: string;
        hashed_token: string;
        scopes: string[];
        vault_id: string;
        created_at: string;
        last_used_at: string | null;
        expires_at: string | null;
      }>;

      const insertKey = database.prepare(
        "INSERT INTO api_keys (id, user_id, vault_id, name, hashed_token, scopes, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );

      for (const k of keys) {
        insertKey.run(
          k.id,
          adminId,
          k.vault_id,
          k.name,
          k.hashed_token,
          k.scopes.join(","),
          k.created_at,
          k.last_used_at,
          k.expires_at,
        );
      }
    }

    // Import trails
    if (hasTrails) {
      const trails = JSON.parse(readFileSync(TRAILS_PATH, "utf-8")) as Array<{
        id: string;
        name: string;
        description: string;
        key_id: string;
        enabled: boolean;
        created_at: string;
        allow_tags: string[];
        deny_tags: string[];
        allow_types: string[];
        deny_types: string[];
        allow_paths: string[];
        deny_paths: string[];
        rate_limit_reads: number;
        rate_limit_writes: number;
      }>;

      const insertTrail = database.prepare(
        "INSERT INTO trails (id, vault_id, name, description, enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const insertGrant = database.prepare(
        "INSERT INTO trail_grants (id, trail_id, grantee_type, grantee_id, created_at) VALUES (?, ?, ?, ?, ?)"
      );

      for (const t of trails) {
        const configJson = JSON.stringify({
          allow_tags: t.allow_tags,
          deny_tags: t.deny_tags,
          allow_types: t.allow_types,
          deny_types: t.deny_types,
          allow_paths: t.allow_paths,
          deny_paths: t.deny_paths,
          rate_limit_reads: t.rate_limit_reads,
          rate_limit_writes: t.rate_limit_writes,
        });

        insertTrail.run(
          t.id,
          "life",                       // default vault
          t.name,
          t.description,
          t.enabled ? 1 : 0,
          configJson,
          t.created_at,
          t.created_at,
        );

        // Create trail_grant linking trail to its API key
        insertGrant.run(
          "grant_" + randomBytes(4).toString("hex"),
          t.id,
          "token",
          t.key_id,
          t.created_at,
        );
      }
    }
  });

  migrate();

  // Rename originals
  if (hasKeys) renameSync(KEYS_PATH, KEYS_PATH + ".migrated");
  if (hasTrails) renameSync(TRAILS_PATH, TRAILS_PATH + ".migrated");

  console.log("[db] Migration complete — JSON files renamed to .migrated");
}
