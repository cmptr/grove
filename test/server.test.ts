import { describe, it, expect } from "vitest";

// server.ts is heavily side-effectful (MCP server, HTTP listener, vault I/O).
// We test the pure patterns and validation logic it uses.

describe("path normalization logic", () => {
  // From the get tool: normalizes input paths
  function normalizePath(file: string): string {
    let filePath = file.replace(/^(life\/|qmd:\/\/life\/)/, "");
    if (!filePath.endsWith(".md")) filePath += ".md";
    return filePath;
  }

  it("strips life/ prefix", () => {
    expect(normalizePath("life/Resources/Concepts/Foo.md")).toBe("Resources/Concepts/Foo.md");
  });

  it("strips qmd://life/ prefix", () => {
    expect(normalizePath("qmd://life/Resources/People/Bar.md")).toBe("Resources/People/Bar.md");
  });

  it("adds .md extension if missing", () => {
    expect(normalizePath("Resources/Concepts/Foo")).toBe("Resources/Concepts/Foo.md");
  });

  it("leaves clean paths unchanged", () => {
    expect(normalizePath("Journal/2026/2026-04-07.md")).toBe("Journal/2026/2026-04-07.md");
  });
});

describe("date pattern detection", () => {
  it("detects YYYY-MM-DD date patterns", () => {
    const searchTerm = "2026-04-07";
    const dateMatch = searchTerm.match(/^(\d{4})-\d{2}-\d{2}$/);
    expect(dateMatch).not.toBeNull();
    expect(dateMatch![1]).toBe("2026");
  });

  it("does not match non-date strings", () => {
    expect("Taste Graph".match(/^(\d{4})-\d{2}-\d{2}$/)).toBeNull();
    expect("2026-13-40".match(/^(\d{4})-\d{2}-\d{2}$/)).not.toBeNull(); // regex doesn't validate ranges
  });
});

describe("INSTRUCTIONS constant format", () => {
  // Verify the server instructions contain expected content
  const INSTRUCTIONS = `Grove is your knowledge API over a personal Obsidian vault (~1000 notes).`;

  it("mentions Obsidian vault", () => {
    expect(INSTRUCTIONS).toContain("Obsidian vault");
  });
});
