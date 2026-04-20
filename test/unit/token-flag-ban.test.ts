import { describe, it, expect } from "vitest";
import { argvContainsToken, guardAgainstTokenInArgv } from "../../src/cli/lib/argv.js";
import { GroveCliError } from "../../src/cli/lib/errors.js";

describe("token-in-argv detection", () => {
  it("detects grove_live_ token in argv", () => {
    expect(argvContainsToken(["search", "x", "--token", "grove_live_abc123def"])).toBe(true);
  });

  it("detects token in --token=value form", () => {
    expect(argvContainsToken(["search", "x", "--token=grove_live_abc123def"])).toBe(true);
  });

  it("detects token as positional", () => {
    expect(argvContainsToken(["grove_live_abc123def"])).toBe(true);
  });

  it("does NOT false-positive on unrelated strings", () => {
    expect(argvContainsToken(["search", "grove is great"])).toBe(false);
    expect(argvContainsToken(["search", "grove_live"])).toBe(false); // too short / no suffix
  });

  it("requires minimum length after grove_live_ (8+ chars)", () => {
    expect(argvContainsToken(["grove_live_abcd1234"])).toBe(true); // 8 chars → match
    expect(argvContainsToken(["grove_live_short"])).toBe(false); // 5 chars → no match
    expect(argvContainsToken(["grove_live_a"])).toBe(false);
  });
});

describe("guardAgainstTokenInArgv", () => {
  it("throws TOKEN_IN_ARGV for non-init commands", () => {
    try {
      guardAgainstTokenInArgv(["search", "x", "--token=grove_live_abc12345"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GroveCliError);
      expect((e as GroveCliError).code).toBe("TOKEN_IN_ARGV");
      expect((e as GroveCliError).exitCode).toBe(1);
    }
  });

  it("allows tokens for init command (only permitted place)", () => {
    expect(() => guardAgainstTokenInArgv(["init", "--token", "grove_live_abc12345"])).not.toThrow();
  });

  it("allows when no token present", () => {
    expect(() => guardAgainstTokenInArgv(["search", "hello"])).not.toThrow();
  });

  it("error includes actionable suggestion", () => {
    try {
      guardAgainstTokenInArgv(["list", "--token=grove_live_abc12345"]);
    } catch (e) {
      expect((e as GroveCliError).suggestions.length).toBeGreaterThan(0);
      expect((e as GroveCliError).suggestions[0]).toContain("grove init");
    }
  });
});
