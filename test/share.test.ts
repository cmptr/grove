import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, email TEXT UNIQUE, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT);
  CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), slug TEXT NOT NULL, display_name TEXT NOT NULL, git_repo_path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), storage_bytes INTEGER NOT NULL DEFAULT 0, storage_quota_bytes INTEGER NOT NULL DEFAULT 104857600, UNIQUE(owner_id, slug));
  CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), vault_id TEXT NOT NULL, name TEXT NOT NULL, hashed_token TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT 'read,write', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT, expires_at TEXT, session_id TEXT);
  CREATE TABLE IF NOT EXISTS shared_links (id TEXT PRIMARY KEY, note_path TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, max_views INTEGER DEFAULT 100, view_count INTEGER DEFAULT 0, created_at TEXT NOT NULL);
`;

const TEST_DIR = mkdtempSync(join(tmpdir(), "grove-share-test-"));
const TEST_DB_PATH = join(TEST_DIR, "grove.db");
process.env.GROVE_DB_PATH = TEST_DB_PATH;

import { getDb, resetDb } from "../src/db.js";
import { createShareLink, resolveShareLink, getShareLink, listShareLinks, deleteShareLink } from "../src/share.js";

function seedDb() {
  const db = getDb();
  db.exec(SCHEMA);
  db.exec("DELETE FROM shared_links");
  db.exec("DELETE FROM api_keys");
  db.exec("DELETE FROM vaults");
  db.exec("DELETE FROM users");

  db.prepare("INSERT INTO users (id, username, email) VALUES (?, ?, ?)").run(
    "user_00000000", "admin", "admin@example.com",
  );
  db.prepare("INSERT INTO vaults (id, owner_id, slug, display_name, git_repo_path) VALUES (?, ?, ?, ?, ?)").run(
    "vault_00000000", "user_00000000", "life", "Life", "/tmp/life",
  );
}

describe("share-a-note links", () => {
  beforeEach(() => {
    resetDb();
    seedDb();
  });

  afterEach(() => {
    resetDb();
  });

  it("creates a share link with defaults", () => {
    const result = createShareLink("Resources/Concepts/taste-graph.md", "user_00000000", "https://api.grove.md");
    expect(result.id).toMatch(/^sh_/);
    expect(result.url).toContain("/s/");
    expect(result.url).toContain("grove.md");
    expect(result.expires_at).toBeTruthy();

    // Verify in DB
    const link = getShareLink(result.id);
    expect(link).not.toBeNull();
    expect(link!.note_path).toBe("Resources/Concepts/taste-graph.md");
    expect(link!.max_views).toBe(100);
    expect(link!.view_count).toBe(0);
  });

  it("creates a share link with custom TTL and max_views", () => {
    const result = createShareLink(
      "Journal/2026/2026-04-01.md", "user_00000000", "https://api.grove.md",
      { ttl_days: 1, max_views: 5 },
    );
    const link = getShareLink(result.id);
    expect(link!.max_views).toBe(5);

    // TTL should be ~1 day from now
    const expiresAt = new Date(link!.expires_at).getTime();
    const expectedExpiry = Date.now() + 1 * 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresAt - expectedExpiry)).toBeLessThan(5000);
  });

  it("resolves a valid share link and increments view count", () => {
    const result = createShareLink("Resources/Concepts/test.md", "user_00000000", "https://api.grove.md");

    const resolved = resolveShareLink(result.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.note_path).toBe("Resources/Concepts/test.md");
    expect(resolved!.view_count).toBe(1);

    // Second resolve should show view_count=2
    const resolved2 = resolveShareLink(result.id);
    expect(resolved2!.view_count).toBe(2);
  });

  it("returns null for non-existent share link", () => {
    expect(resolveShareLink("sh_nonexistent")).toBeNull();
  });

  it("returns null for expired share link", () => {
    const db = getDb();
    const id = "sh_expired";
    const pastDate = new Date(Date.now() - 1000).toISOString();
    db.prepare(
      "INSERT INTO shared_links (id, note_path, created_by, expires_at, max_views, view_count, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    ).run(id, "test.md", "user_00000000", pastDate, 100, new Date().toISOString());

    expect(resolveShareLink(id)).toBeNull();
  });

  it("returns null when max_views is exhausted", () => {
    const result = createShareLink("test.md", "user_00000000", "https://api.grove.md", { max_views: 2 });

    // Use up both views
    resolveShareLink(result.id);
    resolveShareLink(result.id);

    // Third should fail
    expect(resolveShareLink(result.id)).toBeNull();
  });

  it("lists share links for a user", () => {
    createShareLink("note1.md", "user_00000000", "https://api.grove.md");
    createShareLink("note2.md", "user_00000000", "https://api.grove.md");

    const links = listShareLinks("user_00000000");
    expect(links).toHaveLength(2);
  });

  it("deletes a share link", () => {
    const result = createShareLink("note.md", "user_00000000", "https://api.grove.md");
    expect(deleteShareLink(result.id)).toBe(true);
    expect(getShareLink(result.id)).toBeNull();
  });

  it("delete returns false for non-existent link", () => {
    expect(deleteShareLink("sh_ghost")).toBe(false);
  });

  it("URL uses grove.md domain, not api.grove.md", () => {
    const result = createShareLink("test.md", "user_00000000", "https://api.grove.md");
    expect(result.url).toMatch(/^https:\/\/grove\.md\/s\/sh_/);
  });
});
