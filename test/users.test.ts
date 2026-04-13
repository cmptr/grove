import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-users-suite-"));
const TEST_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_DB_PATH = TEST_DB_PATH;

import { getDb, resetDb, createSchema } from "../src/db.js";
import { createUser, getUserById, getUserByEmail, getUserRole, type UserRole } from "../src/users.js";

describe("user roles", () => {
  beforeEach(() => {
    resetDb();
    createSchema();
    // Seed admin user (mirrors runMigration fresh-install path)
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO users (id, username, email, role) VALUES (?, ?, ?, ?)").run(
      "user_00000000", "admin", "admin@grove.local", "owner",
    );
    db.prepare("INSERT OR IGNORE INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run(
      "vault_00000000", "user_00000000", "life", "Life", "/tmp/life",
    );
  });

  afterEach(() => {
    resetDb();
  });

  it("admin user has owner role", () => {
    const role = getUserRole("user_00000000");
    expect(role).toBe("owner");
  });

  it("createUser defaults to viewer role", () => {
    const user = createUser("alice@example.com", "alice");
    expect(user.role).toBe("viewer");

    const role = getUserRole(user.id);
    expect(role).toBe("viewer");
  });

  it("createUser accepts explicit role", () => {
    const member = createUser("bob@example.com", "bob", "member");
    expect(member.role).toBe("member");
    expect(getUserRole(member.id)).toBe("member");

    const owner = createUser("carol@example.com", "carol", "owner");
    expect(owner.role).toBe("owner");
    expect(getUserRole(owner.id)).toBe("owner");
  });

  it("getUserRole returns null for non-existent user", () => {
    const role = getUserRole("user_nonexistent");
    expect(role).toBeNull();
  });

  it("role column persists in the database", () => {
    const user = createUser("dave@example.com", "dave", "member");
    const fetched = getUserById(user.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.role).toBe("member");
  });

  it("getUserByEmail includes role", () => {
    createUser("eve@example.com", "eve", "viewer");
    const fetched = getUserByEmail("eve@example.com");
    expect(fetched).not.toBeNull();
    expect(fetched!.role).toBe("viewer");
  });
});

describe("role migration", () => {
  it("migrateUserRoles adds role column to existing table and sets admin to owner", () => {
    // Use a separate DB to avoid conflicts with the seeded state above
    const { mkdtempSync: mkdtemp } = require("node:fs");
    const migrationDir = mkdtemp(join(tmpdir(), "grove-migration-test-"));
    const migrationDbPath = join(migrationDir, "grove.db");
    const Database = require("better-sqlite3");
    const db = new Database(migrationDbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Create a users table WITHOUT the role column (simulates pre-migration schema)
    db.exec(`
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
    `);
    db.prepare("INSERT INTO users (id, username, email) VALUES (?, ?, ?)").run(
      "user_00000000", "admin", "admin@grove.local",
    );
    db.prepare("INSERT INTO users (id, username, email) VALUES (?, ?, ?)").run(
      "user_viewer01", "viewer1", "viewer@example.com",
    );

    // Verify role column doesn't exist yet
    const colsBefore = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
    expect(colsBefore.some((c: { name: string }) => c.name === "role")).toBe(false);

    // Point the singleton at this DB, run createSchema (which triggers migrateUserRoles)
    const origPath = process.env.GROVE_DB_PATH;
    process.env.GROVE_DB_PATH = migrationDbPath;
    db.close();
    resetDb();
    createSchema();

    const migratedDb = getDb();
    const adminRole = migratedDb.prepare("SELECT role FROM users WHERE id = ?").get("user_00000000") as { role: string };
    expect(adminRole.role).toBe("owner");

    const viewerRole = migratedDb.prepare("SELECT role FROM users WHERE id = ?").get("user_viewer01") as { role: string };
    expect(viewerRole.role).toBe("viewer");

    // Restore original DB path
    process.env.GROVE_DB_PATH = origPath;
    resetDb();

    const { rmSync: rm } = require("node:fs");
    rm(migrationDir, { recursive: true, force: true });
  });
});
