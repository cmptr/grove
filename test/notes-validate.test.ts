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
    expect(() => validatePath(root, "sub/../other.md")).toThrow("Path contains ..");
  });

  it("rejects paths that escape the vault root", () => {
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
  // Type flexibility
  it("accepts any type string", () => {
    const { errors } = validateNote("Inbox/test.md", {
      type: "widget",
      tags: ["widget"],
    }, "");
    expect(errors).toEqual([]);
  });

  it("rejects missing type", () => {
    const { errors } = validateNote("Inbox/test.md", { tags: ["concept"] }, "");
    expect(errors).toEqual([expect.stringContaining("Missing required field 'type'")]);
  });

  // Tags — just need at least one
  it("rejects empty tags", () => {
    const { errors } = validateNote("Inbox/test.md", {
      type: "concept",
      tags: [],
    }, "");
    expect(errors).toEqual([expect.stringContaining("At least one tag")]);
  });

  it("rejects missing tags", () => {
    const { errors } = validateNote("Inbox/test.md", {
      type: "concept",
    }, "");
    expect(errors).toEqual([expect.stringContaining("At least one tag")]);
  });

  it("accepts any tag — no forced type-tag matching", () => {
    const { errors } = validateNote("Resources/Concepts/Foo.md", {
      type: "concept",
      tags: ["ai", "research"],
    }, "Some content");
    expect(errors).toEqual([]);
  });

  // Known type required fields
  it("rejects journal missing date", () => {
    const { errors } = validateNote("Journal/2026/2026-04-01.md", {
      type: "journal",
      tags: ["journal"],
    }, "");
    expect(errors).toEqual([
      expect.stringContaining("Missing required field 'date'"),
    ]);
  });

  it("accepts journal with just date (source not required)", () => {
    const { errors } = validateNote("Journal/2026/2026-04-01.md", {
      type: "journal",
      tags: ["journal"],
      date: "2026-04-01",
    }, "");
    expect(errors).toEqual([]);
  });

  it("rejects recipe missing meal_type", () => {
    const { errors } = validateNote("Resources/Recipes/Pasta.md", {
      type: "recipe",
      tags: ["recipe"],
    }, "");
    expect(errors).toEqual([
      expect.stringContaining("Missing required field 'meal_type'"),
    ]);
  });

  // Path/type: only reject cross-type conflicts
  it("rejects type placed in another type's folder", () => {
    const { errors } = validateNote("Resources/People/Foo.md", {
      type: "concept",
      tags: ["concept"],
    }, "");
    expect(errors).toEqual([
      expect.stringContaining("Type 'concept' cannot be placed under Resources/People/"),
    ]);
  });

  it("allows type in a folder with no type claim", () => {
    const { errors } = validateNote("Areas/Health/Sleep Tracking.md", {
      type: "concept",
      tags: ["concept"],
    }, "");
    expect(errors).toEqual([]);
  });

  it("allows type in its own designated folder", () => {
    const { errors } = validateNote("Resources/Concepts/Foo.md", {
      type: "concept",
      tags: ["concept"],
    }, "Some content");
    expect(errors).toEqual([]);
  });

  // Source notes — no special required fields
  it("accepts a source note with any tags", () => {
    const { errors } = validateNote("Sources/2026-04-02 @karpathy - LLM Knowledge Bases.md", {
      type: "source",
      tags: ["x-bookmark"],
    }, "Some content");
    expect(errors).toEqual([]);
  });

  it("accepts source note with non-bookmark tags", () => {
    const { errors } = validateNote("Sources/some-article.md", {
      type: "source",
      tags: ["article", "research"],
    }, "");
    expect(errors).toEqual([]);
  });

  // Journal filename
  it("rejects bad journal filename", () => {
    const { errors } = validateNote("Journal/2026/my-journal.md", {
      type: "journal",
      tags: ["journal"],
      date: "2026-04-01",
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
    }, "");
    expect(errors).toEqual([]);
  });

  // Size limit
  it("rejects oversized content", () => {
    const huge = "x".repeat(101 * 1024);
    const { errors } = validateNote("Inbox/big.md", {
      type: "concept",
      tags: ["concept"],
    }, huge);
    expect(errors).toEqual([expect.stringContaining("exceeds 100KB limit")]);
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
