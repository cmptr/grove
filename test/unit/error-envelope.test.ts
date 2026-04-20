import { describe, it, expect } from "vitest";
import { GroveCliError, ERROR_CODES, exitCodeFor, ok } from "../../src/cli/lib/errors.js";

describe("error envelope", () => {
  it("required fields: code, message", () => {
    const err = new GroveCliError("NOT_FOUND", "no such note");
    const env = err.toEnvelope();
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("NOT_FOUND");
    expect(env.error.message).toBe("no such note");
  });

  it("includes hint, suggestions, details when provided", () => {
    const err = new GroveCliError("CONFLICT", "hash changed", {
      hint: "re-read and retry",
      suggestions: ["grove get path.md", "grove write path.md --if-hash <new>"],
      details: { expected: "abc", actual: "def" },
    });
    const env = err.toEnvelope();
    expect(env.error.hint).toBe("re-read and retry");
    expect(env.error.suggestions).toEqual([
      "grove get path.md",
      "grove write path.md --if-hash <new>",
    ]);
    expect(env.error.details).toEqual({ expected: "abc", actual: "def" });
  });

  it("omits hint/suggestions/details when absent", () => {
    const err = new GroveCliError("BAD_REQUEST", "boom");
    const env = err.toEnvelope();
    expect(env.error).not.toHaveProperty("hint");
    expect(env.error).not.toHaveProperty("suggestions");
    expect(env.error).not.toHaveProperty("details");
  });

  it("ok envelope structure", () => {
    const env = ok({ path: "x.md" });
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ path: "x.md" });
  });

  it("ok envelope includes idempotency_key when provided", () => {
    const env = ok({ path: "x.md" }, "idemp_abc");
    expect(env.idempotency_key).toBe("idemp_abc");
  });

  it("error codes enum stable", () => {
    expect(ERROR_CODES.NOT_FOUND).toBe("NOT_FOUND");
    expect(ERROR_CODES.CONFLICT).toBe("CONFLICT");
    expect(ERROR_CODES.AUTH_FAILED).toBe("AUTH_FAILED");
  });

  it("suggestions must be an array of strings (type contract)", () => {
    const err = new GroveCliError("NOT_FOUND", "x", { suggestions: ["grove get x"] });
    const env = err.toEnvelope();
    expect(Array.isArray(env.error.suggestions)).toBe(true);
    for (const s of env.error.suggestions!) expect(typeof s).toBe("string");
  });
});

describe("exitCodeFor", () => {
  it("usage/input errors → 1", () => {
    expect(exitCodeFor("USAGE_ERROR")).toBe(1);
    expect(exitCodeFor("BAD_REQUEST")).toBe(1);
    expect(exitCodeFor("VALIDATION_FAILED")).toBe(1);
    expect(exitCodeFor("TOKEN_IN_ARGV")).toBe(1);
    expect(exitCodeFor("CONFIRMATION_REQUIRED")).toBe(1);
  });

  it("auth/config → 2", () => {
    expect(exitCodeFor("AUTH_FAILED")).toBe(2);
    expect(exitCodeFor("CONFIG_MISSING")).toBe(2);
    expect(exitCodeFor("CONFIG_INSECURE")).toBe(2);
    expect(exitCodeFor("PERMISSION_DENIED")).toBe(2);
  });

  it("server/net/rate → 3", () => {
    expect(exitCodeFor("SERVER_ERROR")).toBe(3);
    expect(exitCodeFor("CONNECTION_REFUSED")).toBe(3);
    expect(exitCodeFor("RATE_LIMITED")).toBe(3);
    expect(exitCodeFor("DEPENDENCY_DOWN")).toBe(3);
  });

  it("conflict/not-found → 4", () => {
    expect(exitCodeFor("CONFLICT")).toBe(4);
    expect(exitCodeFor("NOT_FOUND")).toBe(4);
  });

  it("unknown code → 1 (safe default)", () => {
    expect(exitCodeFor("SOME_NEW_CODE")).toBe(1);
  });

  it("exit codes collapsed to 0/1/2/3/4 only", () => {
    const codes = Object.values(ERROR_CODES);
    for (const code of codes) {
      const exit = exitCodeFor(code);
      expect([1, 2, 3, 4]).toContain(exit);
    }
  });
});

describe("GroveCliError exitCode", () => {
  it("derives exit code from error code", () => {
    expect(new GroveCliError("CONFLICT", "x").exitCode).toBe(4);
    expect(new GroveCliError("AUTH_FAILED", "x").exitCode).toBe(2);
    expect(new GroveCliError("SERVER_ERROR", "x").exitCode).toBe(3);
  });
});
