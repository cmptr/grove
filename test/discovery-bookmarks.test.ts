import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  bookmarkToNote,
  existingTweetIds,
  syncBookmarks,
  type BirdBookmark,
} from "../src/discovery-bookmarks.js";
import {
  createSchema,
  closeDb,
  resetDb,
  getDb,
} from "../src/db.js";

// ── Fixtures ─────────────────────────────────────────────────────

function makeBirdBookmark(overrides: Partial<BirdBookmark> = {}): BirdBookmark {
  return {
    id: "123456789",
    text: "This is an interesting tweet about knowledge graphs",
    createdAt: "Sat Apr 11 15:52:54 +0000 2026",
    author: { username: "testuser", name: "Test User" },
    ...overrides,
  };
}

// ── bookmarkToNote ───────────────────────────────────────────────

describe("bookmarkToNote", () => {
  it("produces correct path and frontmatter", () => {
    const bm = makeBirdBookmark();
    const note = bookmarkToNote(bm);

    expect(note.path).toMatch(/^Sources\/X\/2026-04-11 @testuser - /);
    expect(note.path).toMatch(/\.md$/);
    expect(note.frontmatter.type).toBe("source");
    expect(note.frontmatter.tags).toEqual(["x-bookmark"]);
    expect(note.frontmatter.author).toBe("@testuser");
    expect(note.frontmatter.tweet_id).toBe("123456789");
    expect(note.frontmatter.url).toBe("https://x.com/testuser/status/123456789");
    expect(note.frontmatter.date).toBe("2026-04-11");
  });

  it("includes tweet text as blockquote", () => {
    const bm = makeBirdBookmark({ text: "Hello world" });
    const note = bookmarkToNote(bm);

    expect(note.content).toContain("> Hello world");
  });

  it("includes engagement stats when present", () => {
    const bm = makeBirdBookmark({ likeCount: 100, retweetCount: 50 });
    const note = bookmarkToNote(bm);

    expect(note.content).toContain("100 likes");
    expect(note.content).toContain("50 retweets");
  });

  it("handles URLs in tweet text for slug generation", () => {
    const bm = makeBirdBookmark({ text: "Check this out https://t.co/abc123" });
    const note = bookmarkToNote(bm);

    // URL should be stripped from slug
    expect(note.path).not.toContain("https");
    expect(note.path).toContain("check-this-out");
  });

  it("falls back to tweet ID for slug when text is all URLs", () => {
    const bm = makeBirdBookmark({ id: "999", text: "https://t.co/abc123" });
    const note = bookmarkToNote(bm);

    expect(note.path).toContain("999");
  });

  it("handles multiline tweet text in blockquote", () => {
    const bm = makeBirdBookmark({ text: "Line one\nLine two\nLine three" });
    const note = bookmarkToNote(bm);

    expect(note.content).toContain("> Line one\n> Line two\n> Line three");
  });
});

// ── existingTweetIds ─────────────────────────────────────────────

describe("existingTweetIds", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-bm-dedup-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty set when Sources/X/ does not exist", () => {
    const ids = existingTweetIds(tempDir);
    expect(ids.size).toBe(0);
  });

  it("extracts tweet_id from existing notes", () => {
    const sourcesDir = join(tempDir, "Sources", "X");
    mkdirSync(sourcesDir, { recursive: true });
    writeFileSync(
      join(sourcesDir, "2026-04-01 @alice - test.md"),
      "---\ntype: source\ntags:\n  - x-bookmark\ntweet_id: \"111\"\n---\nContent here\n",
    );
    writeFileSync(
      join(sourcesDir, "2026-04-02 @bob - other.md"),
      "---\ntype: source\ntags:\n  - x-bookmark\ntweet_id: \"222\"\n---\nMore content\n",
    );

    const ids = existingTweetIds(tempDir);
    expect(ids.has("111")).toBe(true);
    expect(ids.has("222")).toBe(true);
    expect(ids.size).toBe(2);
  });

  it("skips files without tweet_id", () => {
    const sourcesDir = join(tempDir, "Sources", "X");
    mkdirSync(sourcesDir, { recursive: true });
    writeFileSync(
      join(sourcesDir, "random.md"),
      "---\ntype: source\n---\nNo tweet id\n",
    );

    const ids = existingTweetIds(tempDir);
    expect(ids.size).toBe(0);
  });
});

// ── syncBookmarks ────────────────────────────────────────────────

describe("syncBookmarks", () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-bm-sync-"));
    vaultDir = join(tempDir, "vault");
    mkdirSync(vaultDir);

    // Set up DB for enqueue
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    resetDb();
    createSchema();
  });

  afterEach(() => {
    closeDb();
    delete process.env.GROVE_DB_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates Source notes from bookmarks", () => {
    const bookmarks = [
      makeBirdBookmark({ id: "aaa", text: "First tweet" }),
      makeBirdBookmark({ id: "bbb", text: "Second tweet" }),
    ];

    const result = syncBookmarks(20, { vaultPath: vaultDir, bookmarks });

    expect(result.fetched).toBe(2);
    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.notes).toHaveLength(2);

    // Verify files were written
    for (const notePath of result.notes) {
      const fullPath = join(vaultDir, notePath);
      const raw = readFileSync(fullPath, "utf-8");
      expect(raw).toContain("type: source");
      expect(raw).toContain("x-bookmark");
    }
  });

  it("deduplicates by tweet ID", () => {
    // Pre-populate with an existing bookmark note
    const sourcesDir = join(vaultDir, "Sources", "X");
    mkdirSync(sourcesDir, { recursive: true });
    writeFileSync(
      join(sourcesDir, "2026-04-01 @alice - existing.md"),
      "---\ntype: source\ntags:\n  - x-bookmark\ntweet_id: \"existing-id\"\n---\nAlready synced\n",
    );

    const bookmarks = [
      makeBirdBookmark({ id: "existing-id", text: "Already synced tweet" }),
      makeBirdBookmark({ id: "new-id", text: "Brand new tweet" }),
    ];

    const result = syncBookmarks(20, { vaultPath: vaultDir, bookmarks });

    expect(result.fetched).toBe(2);
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("enqueues new notes for discovery", () => {
    const bookmarks = [
      makeBirdBookmark({ id: "q1", text: "Queued tweet one" }),
      makeBirdBookmark({ id: "q2", text: "Queued tweet two" }),
    ];

    const result = syncBookmarks(20, { vaultPath: vaultDir, bookmarks });

    expect(result.enqueued).toBe(2);

    // Verify entries in discovery_queue
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM discovery_queue WHERE trigger = 'ingest' ORDER BY id")
      .all() as Array<{ path: string; status: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("pending");
  });

  it("handles empty bookmark list", () => {
    const result = syncBookmarks(20, { vaultPath: vaultDir, bookmarks: [] });

    expect(result.fetched).toBe(0);
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("does not enqueue skipped duplicates", () => {
    const sourcesDir = join(vaultDir, "Sources", "X");
    mkdirSync(sourcesDir, { recursive: true });
    writeFileSync(
      join(sourcesDir, "old.md"),
      "---\ntype: source\ntweet_id: \"dup-1\"\n---\nOld\n",
    );

    const bookmarks = [makeBirdBookmark({ id: "dup-1", text: "duplicate" })];
    const result = syncBookmarks(20, { vaultPath: vaultDir, bookmarks });

    expect(result.enqueued).toBe(0);

    const db = getDb();
    const count = db.prepare("SELECT COUNT(*) as c FROM discovery_queue").get() as { c: number };
    expect(count.c).toBe(0);
  });
});
