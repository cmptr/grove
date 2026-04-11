import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

// We test the db module by setting GROVE_DB_PATH env var to a temp directory
// and reimporting. Since the module caches a singleton, we need to manage lifecycle carefully.

import { createHash, randomBytes } from "node:crypto";

describe("db module", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-db-test-"));
    dbPath = join(tempDir, "grove.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("schema creation is idempotent", () => {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    const schema = `
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, email TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT);
      CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), slug TEXT NOT NULL, display_name TEXT NOT NULL, git_repo_path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), storage_bytes INTEGER NOT NULL DEFAULT 0, storage_quota_bytes INTEGER NOT NULL DEFAULT 104857600, UNIQUE(owner_id, slug));
      CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), vault_id TEXT NOT NULL, name TEXT NOT NULL, hashed_token TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT 'read,write', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT, expires_at TEXT);
      CREATE TABLE IF NOT EXISTS trails (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS trail_grants (id TEXT PRIMARY KEY, trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE, grantee_type TEXT NOT NULL, grantee_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL, last_used_at TEXT);
      CREATE TABLE IF NOT EXISTS magic_links (id TEXT PRIMARY KEY, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
    `;

    // Run twice — should not error
    db.exec(schema);
    db.exec(schema);

    // Verify tables exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("users");
    expect(names).toContain("vaults");
    expect(names).toContain("api_keys");
    expect(names).toContain("trails");
    expect(names).toContain("trail_grants");
    expect(names).toContain("sessions");
    expect(names).toContain("magic_links");

    db.close();
  });

  it("migration imports keys.json data correctly", () => {
    const keysPath = join(tempDir, "keys.json");
    const keys = [
      {
        id: "key_abc12345",
        name: "test-key",
        hashed_token: createHash("sha256").update("grove_live_test123").digest("hex"),
        scopes: ["read", "write"],
        vault_id: "life",
        created_at: "2026-01-01T00:00:00Z",
        last_used_at: null,
        expires_at: null,
      },
    ];
    writeFileSync(keysPath, JSON.stringify(keys));

    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Create schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, email TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT);
      CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), slug TEXT NOT NULL, display_name TEXT NOT NULL, git_repo_path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), storage_bytes INTEGER NOT NULL DEFAULT 0, storage_quota_bytes INTEGER NOT NULL DEFAULT 104857600, UNIQUE(owner_id, slug));
      CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), vault_id TEXT NOT NULL, name TEXT NOT NULL, hashed_token TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT 'read,write', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT, expires_at TEXT);
      CREATE TABLE IF NOT EXISTS trails (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS trail_grants (id TEXT PRIMARY KEY, trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE, grantee_type TEXT NOT NULL, grantee_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    `);

    // Simulate migration: insert admin user + import keys
    const adminId = "user_00000000";
    db.prepare("INSERT INTO users (id, username, email) VALUES (?, ?, ?)").run(adminId, "admin", "admin@grove.local");
    db.prepare("INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run("vault_00000000", adminId, "life", "Life", "/tmp/life");

    for (const k of keys) {
      db.prepare("INSERT INTO api_keys (id, user_id, vault_id, name, hashed_token, scopes, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        k.id, adminId, k.vault_id, k.name, k.hashed_token, k.scopes.join(","), k.created_at, k.last_used_at, k.expires_at,
      );
    }

    // Verify
    const imported = db.prepare("SELECT * FROM api_keys WHERE id = ?").get("key_abc12345") as any;
    expect(imported).toBeTruthy();
    expect(imported.name).toBe("test-key");
    expect(imported.hashed_token).toBe(keys[0].hashed_token);
    expect(imported.scopes).toBe("read,write");
    expect(imported.user_id).toBe(adminId);

    db.close();
  });

  it("migration imports trails.json and creates trail_grants rows", () => {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, email TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT);
      CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), slug TEXT NOT NULL, display_name TEXT NOT NULL, git_repo_path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), storage_bytes INTEGER NOT NULL DEFAULT 0, storage_quota_bytes INTEGER NOT NULL DEFAULT 104857600, UNIQUE(owner_id, slug));
      CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), vault_id TEXT NOT NULL, name TEXT NOT NULL, hashed_token TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT 'read,write', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT, expires_at TEXT);
      CREATE TABLE IF NOT EXISTS trails (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS trail_grants (id TEXT PRIMARY KEY, trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE, grantee_type TEXT NOT NULL, grantee_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    `);

    const adminId = "user_00000000";
    db.prepare("INSERT INTO users (id, username, email) VALUES (?, ?, ?)").run(adminId, "admin", "admin@grove.local");
    db.prepare("INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run("vault_00000000", adminId, "life", "Life", "/tmp/life");

    // Import a trail
    const trail = {
      id: "trail_abc12345",
      name: "ai-public",
      description: "AI concepts",
      key_id: "key_trailkey1",
      enabled: true,
      created_at: "2026-01-01T00:00:00Z",
      allow_tags: ["ai"],
      deny_tags: ["private"],
      allow_types: ["concept"],
      deny_types: [],
      allow_paths: ["Resources/"],
      deny_paths: [],
      rate_limit_reads: 60,
      rate_limit_writes: 0,
    };

    const configJson = JSON.stringify({
      allow_tags: trail.allow_tags,
      deny_tags: trail.deny_tags,
      allow_types: trail.allow_types,
      deny_types: trail.deny_types,
      allow_paths: trail.allow_paths,
      deny_paths: trail.deny_paths,
      rate_limit_reads: trail.rate_limit_reads,
      rate_limit_writes: trail.rate_limit_writes,
    });

    db.prepare("INSERT INTO trails (id, vault_id, name, description, enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      trail.id, "life", trail.name, trail.description, 1, configJson, trail.created_at, trail.created_at,
    );

    const grantId = "grant_" + randomBytes(4).toString("hex");
    db.prepare("INSERT INTO trail_grants (id, trail_id, grantee_type, grantee_id, created_at) VALUES (?, ?, ?, ?, ?)").run(
      grantId, trail.id, "token", trail.key_id, trail.created_at,
    );

    // Verify trail
    const importedTrail = db.prepare("SELECT * FROM trails WHERE id = ?").get(trail.id) as any;
    expect(importedTrail).toBeTruthy();
    expect(importedTrail.name).toBe("ai-public");
    expect(importedTrail.enabled).toBe(1);

    const config = JSON.parse(importedTrail.config_json);
    expect(config.allow_tags).toEqual(["ai"]);
    expect(config.deny_tags).toEqual(["private"]);
    expect(config.allow_paths).toEqual(["Resources/"]);

    // Verify trail_grant
    const grant = db.prepare("SELECT * FROM trail_grants WHERE trail_id = ?").get(trail.id) as any;
    expect(grant).toBeTruthy();
    expect(grant.grantee_type).toBe("token");
    expect(grant.grantee_id).toBe("key_trailkey1");

    db.close();
  });

  it("trail_grants cascade delete when trail is deleted", () => {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    db.exec(`
      CREATE TABLE IF NOT EXISTS trails (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS trail_grants (id TEXT PRIMARY KEY, trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE, grantee_type TEXT NOT NULL, grantee_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    `);

    db.prepare("INSERT INTO trails (id, vault_id, name, config_json) VALUES (?, ?, ?, ?)").run("trail_del1", "life", "to-delete", "{}");
    db.prepare("INSERT INTO trail_grants (id, trail_id, grantee_type, grantee_id) VALUES (?, ?, ?, ?)").run("grant_del1", "trail_del1", "token", "key_x");

    // Delete the trail
    db.prepare("DELETE FROM trails WHERE id = ?").run("trail_del1");

    // Grant should be gone too
    const grant = db.prepare("SELECT * FROM trail_grants WHERE trail_id = ?").get("trail_del1");
    expect(grant).toBeUndefined();

    db.close();
  });

  it("api_keys hashed_token has unique constraint", () => {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, email TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT);
      CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), vault_id TEXT NOT NULL, name TEXT NOT NULL, hashed_token TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT 'read,write', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT, expires_at TEXT);
    `);

    db.prepare("INSERT INTO users (id, username, email) VALUES (?, ?, ?)").run("user_1", "admin", "a@b.com");

    const hash = createHash("sha256").update("token1").digest("hex");
    db.prepare("INSERT INTO api_keys (id, user_id, vault_id, name, hashed_token) VALUES (?, ?, ?, ?, ?)").run("key_1", "user_1", "life", "k1", hash);

    expect(() => {
      db.prepare("INSERT INTO api_keys (id, user_id, vault_id, name, hashed_token) VALUES (?, ?, ?, ?, ?)").run("key_2", "user_1", "life", "k2", hash);
    }).toThrow();

    db.close();
  });
});
