import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  generateIdempotencyKey,
  resolveIdempotencyKey,
  __resetTestSeq,
} from "../../src/cli/lib/idempotency.js";

describe("idempotency keys", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    __resetTestSeq();
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("prod keys are prefixed and hex", () => {
    delete process.env.GROVE_TEST_SEED;
    const k = generateIdempotencyKey();
    expect(k.startsWith("idemp_")).toBe(true);
    expect(k.slice(6)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("prod keys are unique across calls", () => {
    delete process.env.GROVE_TEST_SEED;
    const a = generateIdempotencyKey();
    const b = generateIdempotencyKey();
    expect(a).not.toBe(b);
  });

  it("test mode produces deterministic sequential keys", () => {
    process.env.GROVE_TEST_SEED = "42";
    __resetTestSeq();
    expect(generateIdempotencyKey()).toBe("test-0");
    expect(generateIdempotencyKey()).toBe("test-1");
    expect(generateIdempotencyKey()).toBe("test-2");
  });

  it("resolveIdempotencyKey returns provided key when non-empty string", () => {
    expect(resolveIdempotencyKey("user-key-abc")).toBe("user-key-abc");
  });

  it("resolveIdempotencyKey generates when boolean true", () => {
    process.env.GROVE_TEST_SEED = "1";
    __resetTestSeq();
    const k = resolveIdempotencyKey(true);
    expect(k).toBe("test-0");
  });

  it("resolveIdempotencyKey generates when undefined", () => {
    process.env.GROVE_TEST_SEED = "1";
    __resetTestSeq();
    const k = resolveIdempotencyKey(undefined);
    expect(k).toBe("test-0");
  });

  it("resolveIdempotencyKey generates when empty string", () => {
    process.env.GROVE_TEST_SEED = "1";
    __resetTestSeq();
    const k = resolveIdempotencyKey("");
    expect(k).toBe("test-0");
  });
});
