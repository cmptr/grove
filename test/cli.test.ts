import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseArgs, CliError, HELP, printCommandHelp } from "../src/cli.js";

// ── parseArgs ───────────────────────────────────────────────────────

describe("parseArgs", () => {
  // parseArgs reads process.stdout.isTTY for auto-detection.
  // Force TTY=true for predictable tests (non-TTY tests override below).
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

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
  });

  it("parses --json as boolean flag", () => {
    const result = parseArgs(["search", "test", "--json"]);
    expect(result.flags.json).toBe(true);
  });

  it("auto-enables json when stdout is not a TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
    const result = parseArgs(["search", "test"]);
    expect(result.flags.json).toBe(true);
  });

  it("does not auto-enable json when stdout is a TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const result = parseArgs(["search", "test"]);
    expect(result.flags.json).toBeUndefined();
  });
});

// ── CliError ────────────────────────────────────────────────────────

describe("CliError", () => {
  it("creates error with code, message, and default exitCode", () => {
    const err = new CliError("not_found", "Note not found");
    expect(err.code).toBe("not_found");
    expect(err.message).toBe("Note not found");
    expect(err.exitCode).toBe(1);
    expect(err).toBeInstanceOf(Error);
  });

  it("creates error with custom exitCode", () => {
    const err = new CliError("auth_error", "Bad token", 2);
    expect(err.exitCode).toBe(2);
  });

  it("creates server error with exitCode 3", () => {
    const err = new CliError("server_error", "Connection refused", 3);
    expect(err.exitCode).toBe(3);
  });

  it("exit code semantics: 1=not_found, 2=auth, 3=server", () => {
    expect(new CliError("not_found", "").exitCode).toBe(1);
    expect(new CliError("bad_request", "").exitCode).toBe(1);
    expect(new CliError("auth_error", "", 2).exitCode).toBe(2);
    expect(new CliError("config_missing", "", 2).exitCode).toBe(2);
    expect(new CliError("server_error", "", 3).exitCode).toBe(3);
    expect(new CliError("connection_refused", "", 3).exitCode).toBe(3);
  });
});

// ── HELP system ────────────────────────────────────────────────────

describe("HELP", () => {
  const expectedCommands = [
    "search", "read", "list", "write", "init",
    "graph", "digest", "health", "metrics",
    "status", "history", "diagnostics",
    "keys", "trails", "sync", "lint", "snapshot", "rollback",
  ];

  it("has entries for all commands", () => {
    for (const cmd of expectedCommands) {
      expect(HELP[cmd], `missing HELP entry for '${cmd}'`).toBeDefined();
    }
  });

  it("every entry has usage, description, and json_schema", () => {
    for (const [cmd, h] of Object.entries(HELP)) {
      expect(h.usage, `${cmd}.usage`).toContain("grove");
      expect(h.description, `${cmd}.description`).toBeTruthy();
      expect(h.json_schema, `${cmd}.json_schema`).toBeTruthy();
    }
  });

  it("every entry has exit codes", () => {
    for (const [cmd, h] of Object.entries(HELP)) {
      expect(h.exit_codes, `${cmd}.exit_codes`).toContain("0=success");
    }
  });
});

describe("printCommandHelp", () => {
  it("formats known command help", () => {
    const out = printCommandHelp("search");
    expect(out).toContain("grove search");
    expect(out).toContain("JSON:");
    expect(out).toContain("Exit:");
  });

  it("returns error for unknown command", () => {
    const out = printCommandHelp("nonexistent");
    expect(out).toContain("Unknown command");
  });

  it("includes flags section when flags exist", () => {
    const out = printCommandHelp("write");
    expect(out).toContain("Flags:");
    expect(out).toContain("--content");
    expect(out).toContain("--type");
  });

  it("includes examples when present", () => {
    const out = printCommandHelp("search");
    expect(out).toContain("Examples:");
    expect(out).toContain("taste graph");
  });
});

// ── parseArgs: --content flag ─────────────────────────────────────

describe("parseArgs --content flag", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  it("parses --content with a string value", () => {
    const result = parseArgs(["write", "path.md", "--content", "hello world", "--type", "concept"]);
    expect(result.flags.content).toBe("hello world");
    expect(result.flags.type).toBe("concept");
  });

  it("parses --content alongside --json", () => {
    const result = parseArgs(["write", "path.md", "--content", "text", "--json"]);
    expect(result.flags.content).toBe("text");
    expect(result.flags.json).toBe(true);
  });
});
