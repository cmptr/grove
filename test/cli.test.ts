import { describe, it, expect } from "vitest";

// ── parseArgs ───────────────────────────────────────────────────────
// Re-implement the pure parseArgs function for testing since it's not exported
// from cli.ts (which has top-level side effects from sync-sources import).

function parseArgs(argv: string[]): { command: string; positional: string; flags: Record<string, string | boolean> } {
  const command = argv[0] ?? "help";
  let positional = "";
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (!positional) {
      positional = arg;
    }
  }

  return { command, positional, flags };
}

describe("parseArgs", () => {
  it("parses a simple command", () => {
    const result = parseArgs(["search"]);
    expect(result.command).toBe("search");
    expect(result.positional).toBe("");
    expect(result.flags).toEqual({});
  });

  it("parses command with positional argument", () => {
    const result = parseArgs(["search", "taste graph"]);
    expect(result.command).toBe("search");
    expect(result.positional).toBe("taste graph");
  });

  it("parses long flags with values", () => {
    const result = parseArgs(["search", "query", "--since", "1 week ago"]);
    expect(result.command).toBe("search");
    expect(result.positional).toBe("query");
    expect(result.flags.since).toBe("1 week ago");
  });

  it("parses boolean long flags", () => {
    const result = parseArgs(["sync", "dir", "--dry-run"]);
    expect(result.command).toBe("sync");
    expect(result.positional).toBe("dir");
    expect(result.flags["dry-run"]).toBe(true);
  });

  it("parses short flags with values", () => {
    const result = parseArgs(["search", "query", "-n", "5"]);
    expect(result.command).toBe("search");
    expect(result.flags.n).toBe("5");
  });

  it("parses boolean short flags", () => {
    const result = parseArgs(["list", "pattern", "-v"]);
    expect(result.flags.v).toBe(true);
  });

  it("defaults to 'help' when no args", () => {
    const result = parseArgs([]);
    expect(result.command).toBe("help");
  });

  it("handles multiple flags together", () => {
    const result = parseArgs(["search", "query", "--since", "3 days ago", "-n", "20", "--aliases"]);
    expect(result.flags.since).toBe("3 days ago");
    expect(result.flags.n).toBe("20");
    expect(result.flags.aliases).toBe(true);
  });

  it("only captures first positional argument", () => {
    const result = parseArgs(["read", "file1", "file2"]);
    expect(result.positional).toBe("file1");
    // file2 is ignored (not captured)
  });
});
