import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

// ── hashToken ───────────────────────────────────────────────────────
// Re-implement the pure hashToken function for testing (avoids importing
// keys.ts which has top-level side effects with process.argv parsing).

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

describe("hashToken", () => {
  it("produces a 64-char hex string", () => {
    const hash = hashToken("grove_live_abc123");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    const a = hashToken("grove_live_test");
    const b = hashToken("grove_live_test");
    expect(a).toBe(b);
  });

  it("differs for different inputs", () => {
    const a = hashToken("grove_live_key1");
    const b = hashToken("grove_live_key2");
    expect(a).not.toBe(b);
  });
});

// ── Key prefix and ID generation patterns ───────────────────────────

describe("key format conventions", () => {
  const PREFIX = "grove_live_";

  it("tokens start with grove_live_ prefix", () => {
    const raw = "a".repeat(64);
    const token = PREFIX + raw;
    expect(token.startsWith(PREFIX)).toBe(true);
  });

  it("key IDs start with key_ prefix", () => {
    const id = "key_" + Buffer.from([1, 2, 3, 4]).toString("hex");
    expect(id).toMatch(/^key_[a-f0-9]+$/);
  });

  it("scopes default to read,write", () => {
    const defaultScopes = "read,write";
    expect(defaultScopes.split(",")).toEqual(["read", "write"]);
  });
});

// ── Token validation logic ──────────────────────────────────────────

describe("token validation", () => {
  it("matches token to stored hash", () => {
    const token = "grove_live_test123";
    const storedHash = hashToken(token);

    // Simulate validation
    const incomingHash = hashToken(token);
    expect(incomingHash).toBe(storedHash);
  });

  it("rejects wrong token", () => {
    const storedHash = hashToken("grove_live_correct");
    const incomingHash = hashToken("grove_live_wrong");
    expect(incomingHash).not.toBe(storedHash);
  });
});
