import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseArgs, CliError, HELP, printCommandHelp, validateDeleteFlags } from "../src/cli.js";

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

  it("accepts a leading boolean flag before the command", () => {
    const result = parseArgs(["--json", "search", "knowledge graph"]);
    expect(result.command).toBe("search");
    expect(result.positional).toBe("knowledge graph");
    expect(result.flags.json).toBe(true);
  });

  it("accepts a leading value flag before the command", () => {
    const result = parseArgs(["-n", "5", "search", "taste"]);
    expect(result.command).toBe("search");
    expect(result.positional).toBe("taste");
    expect(result.flags.n).toBe("5");
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
    "search", "read", "list", "write", "delete", "move", "init",
    "graph", "digest", "health", "metrics",
    "status", "history", "diagnostics",
    "keys", "trails", "vault", "sync", "ingest", "lint", "snapshot", "rollback",
    "whoami", "tag-backfill",
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

// ── parseArgs: ingest flags ──────────────────────────────────────

describe("parseArgs ingest flags", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  it("parses ingest command with directory", () => {
    const result = parseArgs(["ingest", "./import/"]);
    expect(result.command).toBe("ingest");
    expect(result.positional).toBe("./import/");
  });

  it("parses ingest with --dry-run", () => {
    const result = parseArgs(["ingest", "./import/", "--dry-run"]);
    expect(result.command).toBe("ingest");
    expect(result.positional).toBe("./import/");
    expect(result.flags["dry-run"]).toBe(true);
  });

  it("parses ingest with --json", () => {
    const result = parseArgs(["ingest", "./import/", "--json"]);
    expect(result.flags.json).toBe(true);
  });
});

// ── HELP: ingest entry ───────────────────────────────────────────

describe("HELP ingest", () => {
  it("has an ingest help entry", () => {
    expect(HELP.ingest).toBeDefined();
  });

  it("ingest help has required fields", () => {
    expect(HELP.ingest.usage).toContain("grove ingest");
    expect(HELP.ingest.description).toContain("Import");
    expect(HELP.ingest.json_schema).toContain("imported");
    expect(HELP.ingest.exit_codes).toContain("0=success");
  });

  it("ingest help includes --dry-run flag", () => {
    expect(HELP.ingest.flags).toBeDefined();
    expect(HELP.ingest.flags!.some((f) => f.includes("dry-run"))).toBe(true);
  });

  it("printCommandHelp renders ingest", () => {
    const out = printCommandHelp("ingest");
    expect(out).toContain("grove ingest");
    expect(out).toContain("dry-run");
    expect(out).toContain("Examples:");
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

// ── parseArgs: vault subcommands ─────────────────────────────────

describe("parseArgs vault", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  it.each(["status", "encrypt", "unlock", "lock"])(
    "parses vault %s as positional",
    (sub) => {
      const result = parseArgs(["vault", sub]);
      expect(result.command).toBe("vault");
      expect(result.positional).toBe(sub);
    },
  );

  it("parses bare `grove vault` with no positional (defaults to status)", () => {
    const result = parseArgs(["vault"]);
    expect(result.command).toBe("vault");
    expect(result.positional).toBe("");
  });

  it("parses vault status with --json", () => {
    const result = parseArgs(["vault", "status", "--json"]);
    expect(result.command).toBe("vault");
    expect(result.positional).toBe("status");
    expect(result.flags.json).toBe(true);
  });
});

// ── HELP: vault entry ────────────────────────────────────────────

describe("HELP vault", () => {
  it("has a vault help entry", () => {
    expect(HELP.vault).toBeDefined();
  });

  it("vault help has required fields", () => {
    expect(HELP.vault.usage).toContain("grove vault");
    expect(HELP.vault.description).toMatch(/encrypt/i);
    expect(HELP.vault.json_schema).toContain("encrypted");
    expect(HELP.vault.exit_codes).toContain("0=success");
  });

  it("vault help lists all four subcommands in usage", () => {
    for (const sub of ["status", "encrypt", "unlock", "lock"]) {
      expect(HELP.vault.usage).toContain(sub);
    }
  });

  it("vault help includes an example using GROVE_VAULT_PASSPHRASE env", () => {
    expect(HELP.vault.examples?.some((e) => e.includes("GROVE_VAULT_PASSPHRASE"))).toBe(true);
  });

  it("printCommandHelp renders vault", () => {
    const out = printCommandHelp("vault");
    expect(out).toContain("grove vault");
    expect(out).toContain("Examples:");
    expect(out).toContain("GROVE_VAULT_PASSPHRASE");
  });
});

// ── Passphrase prompt helper ─────────────────────────────────────

describe("promptPassphrase", () => {
  it("returns env var value when set", async () => {
    const { promptPassphrase } = await import("../src/cli/lib/passphrase.js");
    process.env.GROVE_TEST_PASSPHRASE = "swordfish";
    try {
      const result = await promptPassphrase("Passphrase", { envVar: "GROVE_TEST_PASSPHRASE" });
      expect(result).toBe("swordfish");
    } finally {
      delete process.env.GROVE_TEST_PASSPHRASE;
    }
  });

  it("errors when stdin is not a TTY and env var is unset", async () => {
    const { promptPassphrase } = await import("../src/cli/lib/passphrase.js");
    const prevTTY = (process.stdin as any).isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    delete process.env.GROVE_TEST_PASSPHRASE;
    try {
      await expect(
        promptPassphrase("Passphrase", { envVar: "GROVE_TEST_PASSPHRASE" }),
      ).rejects.toThrow(/PASSPHRASE_REQUIRED|TTY/i);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: prevTTY, configurable: true });
    }
  });

  it("treats an empty env var as unset (falls through to TTY/error)", async () => {
    const { promptPassphrase } = await import("../src/cli/lib/passphrase.js");
    const prevTTY = (process.stdin as any).isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    process.env.GROVE_TEST_PASSPHRASE = "";
    try {
      await expect(
        promptPassphrase("Passphrase", { envVar: "GROVE_TEST_PASSPHRASE" }),
      ).rejects.toThrow(/PASSPHRASE_REQUIRED|TTY/i);
    } finally {
      delete process.env.GROVE_TEST_PASSPHRASE;
      Object.defineProperty(process.stdin, "isTTY", { value: prevTTY, configurable: true });
    }
  });
});

// ── parseArgs: delete / move ────────────────────────────────────

describe("parseArgs delete", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  it("parses `grove delete <path>`", () => {
    const result = parseArgs(["delete", "Inbox/old-idea.md"]);
    expect(result.command).toBe("delete");
    expect(result.positional).toBe("Inbox/old-idea.md");
    expect(result.flags.hard).toBeUndefined();
  });

  it("parses --hard as a boolean flag (no positional consumed)", () => {
    const result = parseArgs(["delete", "Inbox/x.md", "--hard", "--yes"]);
    expect(result.positional).toBe("Inbox/x.md");
    expect(result.flags.hard).toBe(true);
    expect(result.flags.yes).toBe(true);
  });

  it("parses delete with --json", () => {
    const result = parseArgs(["delete", "Inbox/x.md", "--json"]);
    expect(result.flags.json).toBe(true);
  });

  it("parses --if-hash on delete", () => {
    const result = parseArgs(["delete", "Inbox/x.md", "--if-hash", "abc123"]);
    expect(result.flags["if-hash"]).toBe("abc123");
  });
});

describe("parseArgs move", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  it("captures both positionals for `grove move <from> <to>`", () => {
    const result = parseArgs(["move", "Inbox/idea.md", "Resources/Concepts/idea.md"]);
    expect(result.command).toBe("move");
    expect(result.positional).toBe("Inbox/idea.md");
    expect(result.positionals).toEqual(["Inbox/idea.md", "Resources/Concepts/idea.md"]);
  });

  it("preserves positionals alongside flags", () => {
    const result = parseArgs(["move", "a.md", "b.md", "--json"]);
    expect(result.positionals).toEqual(["a.md", "b.md"]);
    expect(result.flags.json).toBe(true);
  });

  it("accepts flags interleaved with positionals", () => {
    const result = parseArgs(["move", "a.md", "--if-hash", "abc", "b.md"]);
    expect(result.positionals).toEqual(["a.md", "b.md"]);
    expect(result.flags["if-hash"]).toBe("abc");
  });
});

// ── validateDeleteFlags ──────────────────────────────────────────

describe("validateDeleteFlags", () => {
  it("allows soft delete with no flags", () => {
    expect(() => validateDeleteFlags({}, "Inbox/x.md")).not.toThrow();
  });

  it("allows --hard when --yes is set", () => {
    expect(() => validateDeleteFlags({ hard: true, yes: true }, "Inbox/x.md")).not.toThrow();
  });

  it("rejects --hard without --yes with exit code 1", () => {
    try {
      validateDeleteFlags({ hard: true }, "Inbox/x.md");
      throw new Error("expected validateDeleteFlags to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(1);
      expect((err as CliError).message).toMatch(/--yes/);
      expect((err as CliError).message).toContain("Inbox/x.md");
    }
  });
});

// ── HELP: delete / move entries ──────────────────────────────────

describe("HELP delete", () => {
  it("has a delete help entry with required fields", () => {
    expect(HELP.delete).toBeDefined();
    expect(HELP.delete.usage).toContain("grove delete");
    expect(HELP.delete.description).toBeTruthy();
    expect(HELP.delete.json_schema).toMatch(/action/);
    expect(HELP.delete.exit_codes).toContain("0=success");
  });

  it("documents --hard and --yes flags", () => {
    const flags = HELP.delete.flags?.join("\n") ?? "";
    expect(flags).toMatch(/--hard/);
    expect(flags).toMatch(/--yes/);
  });

  it("json_schema covers both archived and deleted actions", () => {
    expect(HELP.delete.json_schema).toMatch(/archived/);
    expect(HELP.delete.json_schema).toMatch(/deleted/);
  });

  it("printCommandHelp renders delete", () => {
    const out = printCommandHelp("delete");
    expect(out).toContain("grove delete");
    expect(out).toContain("--hard");
    expect(out).toContain("Examples:");
  });
});

describe("HELP move", () => {
  it("has a move help entry with required fields", () => {
    expect(HELP.move).toBeDefined();
    expect(HELP.move.usage).toContain("grove move");
    expect(HELP.move.usage).toMatch(/<from>/);
    expect(HELP.move.usage).toMatch(/<to>/);
    expect(HELP.move.json_schema).toMatch(/links_updated/);
    expect(HELP.move.exit_codes).toContain("0=success");
  });

  it("printCommandHelp renders move", () => {
    const out = printCommandHelp("move");
    expect(out).toContain("grove move");
    expect(out).toContain("Examples:");
  });
});
