import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { resetDb, getDb, createSchema } from "../src/db.js";

/**
 * P19-1 migration — shared_links table rebuild so `max_views` is nullable and
 * `last_accessed_at`, `revoked_by`, `revoked_at` columns exist. Verifies
 * existing rows survive, the new schema is in place, and running twice is a
 * no-op.
 */
describe("shared_links migration (P19-1)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-migrate-test-"));
    dbPath = join(tempDir, "grove.db");
    process.env.GROVE_DB_PATH = dbPath;
    resetDb();
  });

  afterEach(() => {
    resetDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedOldSchema(): void {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        role TEXT NOT NULL DEFAULT 'viewer',
        display_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at TEXT,
        bio TEXT
      );
      CREATE TABLE shared_links (
        id TEXT PRIMARY KEY,
        note_path TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL,
        max_views INTEGER DEFAULT 100,
        view_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO users (id, username, email, role) VALUES (?, ?, ?, ?)")
      .run("user_00000000", "admin", "admin@grove.local", "owner");

    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 1000).toISOString();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO shared_links (id, note_path, created_by, expires_at, max_views, view_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("sh_keep1", "a.md", "user_00000000", future, 100, 3, now);
    db.prepare(
      "INSERT INTO shared_links (id, note_path, created_by, expires_at, max_views, view_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("sh_keep2", "b.md", "user_00000000", past, 10, 10, now);
    db.close();
  }

  it("adds new columns and preserves existing rows", () => {
    seedOldSchema();

    createSchema();
    const db = getDb();

    const cols = db.prepare("PRAGMA table_info(shared_links)").all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("last_accessed_at")).toBe(true);
    expect(names.has("revoked_by")).toBe(true);
    expect(names.has("revoked_at")).toBe(true);

    const maxViewsCol = cols.find((c) => c.name === "max_views");
    expect(maxViewsCol).toBeDefined();
    expect(maxViewsCol!.notnull).toBe(0); // nullable

    const rows = db.prepare("SELECT * FROM shared_links ORDER BY id").all() as Array<{
      id: string;
      note_path: string;
      max_views: number | null;
      view_count: number;
      last_accessed_at: string | null;
      revoked_by: string | null;
      revoked_at: string | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe("sh_keep1");
    expect(rows[0].max_views).toBe(100);
    expect(rows[0].view_count).toBe(3);
    expect(rows[0].last_accessed_at).toBeNull();
    expect(rows[0].revoked_by).toBeNull();
    expect(rows[0].revoked_at).toBeNull();
    expect(rows[1].id).toBe("sh_keep2");
    expect(rows[1].view_count).toBe(10);

    const fkCheck = db.prepare("PRAGMA foreign_key_check").all();
    expect(fkCheck).toHaveLength(0);
  });

  it("allows inserting NULL max_views after migration", () => {
    seedOldSchema();
    createSchema();
    const db = getDb();

    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO shared_links (id, note_path, created_by, expires_at, max_views, view_count, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    ).run("sh_unlim", "u.md", "user_00000000", future, null, new Date().toISOString());

    const row = db.prepare("SELECT max_views FROM shared_links WHERE id = ?").get("sh_unlim") as {
      max_views: number | null;
    };
    expect(row.max_views).toBeNull();
  });

  it("running migration twice is a no-op", () => {
    seedOldSchema();

    createSchema();
    const dbAfterFirst = getDb();
    const rowsAfterFirst = dbAfterFirst.prepare("SELECT * FROM shared_links ORDER BY id").all();

    // Second run — should not rebuild, should not lose data, should not throw.
    createSchema();
    const dbAfterSecond = getDb();
    const rowsAfterSecond = dbAfterSecond.prepare("SELECT * FROM shared_links ORDER BY id").all();

    expect(rowsAfterSecond).toEqual(rowsAfterFirst);

    const fkCheck = dbAfterSecond.prepare("PRAGMA foreign_key_check").all();
    expect(fkCheck).toHaveLength(0);
  });

  it("fresh schema (no pre-existing table) creates the new shape directly", () => {
    createSchema();
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(shared_links)").all() as {
      name: string;
      notnull: number;
    }[];
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("last_accessed_at")).toBe(true);
    expect(names.has("revoked_by")).toBe(true);
    expect(names.has("revoked_at")).toBe(true);
    expect(cols.find((c) => c.name === "max_views")!.notnull).toBe(0);
  });
});
