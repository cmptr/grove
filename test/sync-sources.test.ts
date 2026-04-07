import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readArchiveSources, planSync, type SourceNote } from "../src/sync-sources.js";

describe("readArchiveSources", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grove-sync-test-"));
  });

  it("reads .md files with proper frontmatter", () => {
    writeFileSync(
      join(dir, "2026-04-02 @karpathy - LLM Knowledge Bases.md"),
      `---
type: source
author: "@karpathy"
url: "https://x.com/karpathy/status/123"
tags:
  - x-bookmark
---

# Content here
`,
    );

    const notes = readArchiveSources(dir);
    expect(notes).toHaveLength(1);
    expect(notes[0].path).toBe("Sources/2026-04-02 @karpathy - LLM Knowledge Bases.md");
    expect(notes[0].frontmatter.type).toBe("source");
    expect(notes[0].frontmatter.author).toBe("@karpathy");
    expect(notes[0].content).toContain("# Content here");
  });

  it("backfills type and tags for legacy notes without them", () => {
    writeFileSync(
      join(dir, "2019-06-20 @ganeumann - Old note.md"),
      `---
author: "@ganeumann"
url: "https://x.com/ganeumann/status/456"
---

Old content
`,
    );

    const notes = readArchiveSources(dir);
    expect(notes).toHaveLength(1);
    expect(notes[0].frontmatter.type).toBe("source");
    expect(notes[0].frontmatter.tags).toContain("x-bookmark");
  });

  it("skips non-.md files and subdirectories", () => {
    writeFileSync(join(dir, "notes.txt"), "not a note");
    mkdirSync(join(dir, "_media"));
    writeFileSync(
      join(dir, "valid.md"),
      `---
type: source
author: "@test"
url: "https://x.com/test/status/1"
tags:
  - x-bookmark
---

content
`,
    );

    const notes = readArchiveSources(dir);
    expect(notes).toHaveLength(1);
    expect(notes[0].path).toBe("Sources/valid.md");
  });

  it("skips the X Bookmarks index file", () => {
    writeFileSync(join(dir, "X Bookmarks.md"), "---\ntype: index\n---\nindex content");
    const notes = readArchiveSources(dir);
    expect(notes).toHaveLength(0);
  });

  it("handles empty directory", () => {
    const notes = readArchiveSources(dir);
    expect(notes).toHaveLength(0);
  });
});

describe("planSync", () => {
  function makeNote(path: string, author = "@test", url = "https://x.com/test/1"): SourceNote {
    return {
      path,
      frontmatter: { type: "source", tags: ["x-bookmark"], author, url },
      content: "content",
    };
  }

  it("creates notes that don't exist on the vault", () => {
    const local = [
      makeNote("Sources/2026-04-02 @karpathy - LLM Knowledge Bases.md"),
      makeNote("Sources/2026-04-06 @bensig - MemPalace.md"),
    ];
    const existing = new Set<string>();

    const plan = planSync(local, existing);
    expect(plan.toCreate).toHaveLength(2);
    expect(plan.skipped).toHaveLength(0);
  });

  it("skips notes that already exist on the vault", () => {
    const local = [
      makeNote("Sources/2026-04-02 @karpathy - LLM Knowledge Bases.md"),
      makeNote("Sources/already-exists.md"),
    ];
    const existing = new Set(["Sources/already-exists.md"]);

    const plan = planSync(local, existing);
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toCreate[0].path).toContain("karpathy");
    expect(plan.skipped).toContain("Sources/already-exists.md");
  });

  it("creates notes without author/url — no longer required", () => {
    const note: SourceNote = {
      path: "Sources/minimal.md",
      frontmatter: { type: "source", tags: ["x-bookmark"] },
      content: "just content",
    };
    const plan = planSync([note], new Set());
    expect(plan.toCreate).toHaveLength(1);
  });

  it("handles empty local array", () => {
    const plan = planSync([], new Set(["Sources/something.md"]));
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });
});
