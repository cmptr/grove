import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validatePath,
  validateNote,
  parseNote,
  serializeNote,
  contentHash,
} from "../src/notes-validate.js";

// ── validatePath ────────────────────────────────────────────────────

describe("validatePath", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "grove-test-"));
  });

  it("accepts a valid .md path", () => {
    const abs = validatePath(root, "Resources/Concepts/Foo.md");
    expect(abs).toBe(join(root, "Resources/Concepts/Foo.md"));
  });

  it("rejects paths containing ..", () => {
    // Use a path that resolves inside root but still contains ..
    expect(() => validatePath(root, "sub/../other.md")).toThrow("Path contains ..");
  });

  it("rejects paths that escape the vault root", () => {
    // Absolute path outside root
    expect(() => validatePath(root, "/etc/passwd.md")).toThrow();
  });

  it("rejects non-.md files", () => {
    expect(() => validatePath(root, "notes.txt")).toThrow("Only .md files allowed");
  });

  it("rejects .obsidian/ paths", () => {
    expect(() => validatePath(root, ".obsidian/config.md")).toThrow(
      "Cannot write into .obsidian/"
    );
  });

  it("rejects symlinks", () => {
    const target = join(root, "real.md");
    const link = join(root, "link.md");
    writeFileSync(target, "content");
    symlinkSync(target, link);
    expect(() => validatePath(root, "link.md")).toThrow("Symlinks not allowed");
  });

  it("allows paths to files that don't exist yet", () => {
    const abs = validatePath(root, "new-note.md");
    expect(abs).toBe(join(root, "new-note.md"));
  });
});

// ── validateNote ────────────────────────────────────────────────────

describe("validateNote", () => {
  it("accepts a valid concept note", () => {
    const { errors } = validateNote("Resources/Concepts/Foo.md", {
      type: "concept",
      tags: ["concept"],
    }, "Some content");
    expect(errors).toEqual([]);
  });

  it("rejects invalid type", () => {
    const { errors } = validateNote("Inbox/test.md", {
      type: "widget",
      tags: ["widget"],
    }, "");
    expect(errors).toEqual([expect.stringContaining("Invalid or missing type")]);
  });

  it("rejects missing type", () => {
    const { errors } = validateNote("Inbox/test.md", { tags: ["concept"] }, "");
    expect(errors).toEqual([expect.stringContaining("Invalid or missing type")]);
  });

  it("rejects missing required fields for journal", () => {
    const { errors } = validateNote("Journal/2026/2026-04-01.md", {
      type: "journal",
      tags: ["journal"],
    }, "");
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Missing required field 'date'"),
        expect.stringContaining("Missing required field 'source'"),
      ])
    );
  });

  it("rejects missing required tag", () => {
    const { errors } = validateNote("Resources/Concepts/Foo.md", {
      type: "concept",
      tags: ["unrelated"],
    }, "");
    expect(errors).toEqual([expect.stringContaining("Tags must include 'concept'")]);
  });

  it("rejects wrong path/type combo", () => {
    const { errors } = validateNote("Resources/People/Foo.md", {
      type: "concept",
      tags: ["concept"],
    }, "");
    expect(errors).toEqual([
      expect.stringContaining("Type 'concept' must be under Resources/Concepts/"),
    ]);
  });

  it("allows any type in Inbox/", () => {
    const { errors } = validateNote("Inbox/random.md", {
      type: "concept",
      tags: ["concept"],
    }, "");
    expect(errors).toEqual([]);
  });

  it("allows any type in Notes/", () => {
    const { errors } = validateNote("Notes/scratch.md", {
      type: "person",
      tags: ["person"],
    }, "");
    expect(errors).toEqual([]);
  });

  it("rejects oversized content", () => {
    const huge = "x".repeat(101 * 1024);
    const { errors } = validateNote("Inbox/big.md", {
      type: "concept",
      tags: ["concept"],
    }, huge);
    expect(errors).toEqual([expect.stringContaining("exceeds 100KB limit")]);
  });

  it("rejects bad journal filename", () => {
    const { errors } = validateNote("Journal/2026/my-journal.md", {
      type: "journal",
      tags: ["journal"],
      date: "2026-04-01",
      source: "manual",
    }, "");
    expect(errors).toEqual([
      expect.stringContaining("Journal entries must match YYYY-MM-DD.md"),
    ]);
  });

  it("accepts valid journal with numbered suffix", () => {
    const { errors } = validateNote("Journal/2026/2026-04-01-2.md", {
      type: "journal",
      tags: ["journal"],
      date: "2026-04-01",
      source: "manual",
    }, "");
    expect(errors).toEqual([]);
  });
});

// ── parseNote ───────────────────────────────────────────────────────

describe("parseNote", () => {
  it("extracts frontmatter and content", () => {
    const raw = `---\ntype: concept\ntags:\n  - concept\n---\nHello world`;
    const { frontmatter, content } = parseNote(raw);
    expect(frontmatter.type).toBe("concept");
    expect((frontmatter.tags as string[])).toContain("concept");
    expect(content).toBe("Hello world");
  });

  it("returns empty frontmatter when none present", () => {
    const raw = "Just content, no frontmatter";
    const { frontmatter, content } = parseNote(raw);
    expect(frontmatter).toEqual({});
    expect(content).toBe(raw);
  });
});

// ── serializeNote ───────────────────────────────────────────────────

describe("serializeNote", () => {
  it("round-trips with parseNote", () => {
    const fm = { type: "person", tags: ["person"], aliases: ["JM"] };
    const body = "Some notes about this person.\n";
    const serialized = serializeNote(fm, body);
    const { frontmatter, content } = parseNote(serialized);
    expect(frontmatter.type).toBe("person");
    expect((frontmatter.tags as string[])).toEqual(["person"]);
    expect((frontmatter.aliases as string[])).toEqual(["JM"]);
    expect(content).toBe(body);
  });
});

// ── contentHash ─────────────────────────────────────────────────────

describe("contentHash", () => {
  it("returns consistent SHA-256 hex", () => {
    const hash1 = contentHash("hello");
    const hash2 = contentHash("hello");
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("differs for different input", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
});
