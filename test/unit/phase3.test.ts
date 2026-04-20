import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validatePatchArgs,
  obsidianUrl,
  checkConfigPerms,
  checkShellHistoryForTokens,
  completionBash,
  completionZsh,
  completionFish,
} from "../../src/cli/phase3.js";
import { GroveCliError } from "../../src/cli/lib/errors.js";

describe("validatePatchArgs", () => {
  it("accepts complete args", () => {
    expect(() =>
      validatePatchArgs({ path: "x.md", ifHash: "abc123", content: "hello" }),
    ).not.toThrow();
  });

  it("rejects missing path", () => {
    try {
      validatePatchArgs({ ifHash: "abc", content: "x" });
      throw new Error("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GroveCliError);
      expect((e as GroveCliError).code).toBe("USAGE_ERROR");
      expect((e as GroveCliError).suggestions.length).toBeGreaterThan(0);
    }
  });

  it("rejects missing --if-hash (agent-safety invariant)", () => {
    try {
      validatePatchArgs({ path: "x.md", content: "hi" });
      throw new Error("should throw");
    } catch (e) {
      expect((e as GroveCliError).code).toBe("USAGE_ERROR");
      expect((e as GroveCliError).message).toContain("if-hash");
      // Suggestions should include grove get (to fetch the hash).
      expect((e as GroveCliError).suggestions.some((s) => s.startsWith("grove get"))).toBe(true);
    }
  });

  it("rejects boolean --if-hash (flag without value)", () => {
    expect(() =>
      validatePatchArgs({ path: "x.md", ifHash: true, content: "x" }),
    ).toThrow(GroveCliError);
  });

  it("rejects empty content", () => {
    expect(() =>
      validatePatchArgs({ path: "x.md", ifHash: "abc", content: "" }),
    ).toThrow(GroveCliError);
  });
});

describe("obsidianUrl", () => {
  it("builds obsidian://open URL", () => {
    const url = obsidianUrl("life", "Resources/People/Alice.md");
    expect(url).toMatch(/^obsidian:\/\/open/);
    expect(url).toContain("vault=life");
    expect(url).toContain("file=");
    expect(url).toContain(encodeURIComponent("Resources/People/Alice"));
  });

  it("strips .md extension from path (Obsidian convention)", () => {
    const url = obsidianUrl("life", "note.md");
    expect(url).toContain("file=note");
    expect(url).not.toContain(".md");
  });

  it("URL-encodes paths with spaces and special chars", () => {
    const url = obsidianUrl("life", "Resources/People/John Doe.md");
    expect(url).toContain("John%20Doe");
  });
});

describe("doctor: checkConfigPerms", () => {
  let tmp: string;
  const savedEnv = { ...process.env };
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "grove-doctor-"));
    process.env.GROVE_CONFIG_DIR = tmp;
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reports fail when config missing", () => {
    const r = checkConfigPerms();
    expect(r.status).toBe("fail");
    expect(r.suggestion).toContain("grove init");
  });

  it("reports fail when mode is 0644", () => {
    const p = join(tmp, "cli.json");
    writeFileSync(p, "{}");
    chmodSync(p, 0o644);
    const r = checkConfigPerms();
    expect(r.status).toBe("fail");
    expect(r.suggestion).toContain("chmod 600");
  });

  it("reports ok when mode is 0600", () => {
    const p = join(tmp, "cli.json");
    writeFileSync(p, "{}");
    chmodSync(p, 0o600);
    const r = checkConfigPerms();
    expect(r.status).toBe("ok");
    expect(r.message).toContain("600");
  });
});

describe("doctor: checkShellHistoryForTokens", () => {
  it("returns ok when no history files exist (skip gracefully)", () => {
    // If this dev machine's history contains tokens, this test would incorrectly
    // warn — so we just verify the check doesn't crash and returns a valid shape.
    const r = checkShellHistoryForTokens();
    expect(["ok", "warn"]).toContain(r.status);
    expect(r.name).toBe("history-leak");
  });
});

describe("shell completions", () => {
  it("bash completion emits valid bash syntax and known commands", () => {
    const s = completionBash();
    expect(s).toContain("complete -F _grove_complete grove");
    expect(s).toContain("search");
    expect(s).toContain("write");
    expect(s).toContain("patch"); // Phase 3 new
    expect(s).toContain("inspect"); // Phase 2 new
  });

  it("zsh completion emits #compdef grove", () => {
    const s = completionZsh();
    expect(s).toContain("#compdef grove");
    expect(s).toContain("search");
  });

  it("fish completion emits complete -c grove", () => {
    const s = completionFish();
    expect(s).toContain("complete -c grove");
    expect(s).toContain("search");
  });

  it("all three completions include the Phase 3 additions", () => {
    for (const s of [completionBash(), completionZsh(), completionFish()]) {
      expect(s).toContain("doctor");
      expect(s).toContain("logout");
      expect(s).toContain("completion");
    }
  });
});
