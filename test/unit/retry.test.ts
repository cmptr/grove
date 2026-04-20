import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseRetryAfter, withRetry } from "../../src/cli/lib/retry.js";

describe("parseRetryAfter", () => {
  it("parses delta-seconds as milliseconds", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("120")).toBe(120_000);
  });

  it("parses HTTP-date as delta from now", () => {
    const future = new Date(Date.now() + 3000).toUTCString();
    const delta = parseRetryAfter(future);
    expect(delta).not.toBeNull();
    expect(delta!).toBeGreaterThan(2000);
    expect(delta!).toBeLessThanOrEqual(3500);
  });

  it("returns 0 for past HTTP-date", () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });

  it("returns null for unparseable values", () => {
    expect(parseRetryAfter("later")).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
  });

  it("trims whitespace", () => {
    expect(parseRetryAfter("  42  ")).toBe(42_000);
  });
});

describe("withRetry", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.GROVE_NO_RETRY;
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("does not retry on 200", async () => {
    let calls = 0;
    const { result, attempts } = await withRetry(async () => {
      calls++;
      return { status: 200 };
    });
    expect(calls).toBe(1);
    expect(attempts).toHaveLength(0);
    expect(result.status).toBe(200);
  });

  it("does not retry on 4xx (other than 429)", async () => {
    let calls = 0;
    const { result, attempts } = await withRetry(async () => {
      calls++;
      return { status: 404 };
    });
    expect(calls).toBe(1);
    expect(attempts).toHaveLength(0);
    expect(result.status).toBe(404);
  });

  it("retries 429 up to maxAttempts (default 3)", async () => {
    let calls = 0;
    const { result, attempts } = await withRetry(
      async () => {
        calls++;
        return { status: 429, headers: { "retry-after": "0" } };
      },
      { baseDelayMs: 1, maxDelayMs: 5 },
    );
    expect(calls).toBe(3);
    expect(attempts).toHaveLength(2); // 3 attempts → 2 delays between them
    expect(result.status).toBe(429);
  });

  it("retries 500 with exponential backoff", async () => {
    let calls = 0;
    const { attempts } = await withRetry(
      async () => {
        calls++;
        return { status: 500 };
      },
      { baseDelayMs: 1, maxDelayMs: 10 },
    );
    expect(calls).toBe(3);
    expect(attempts[0].reason).toContain("500");
  });

  it("honors Retry-After header for 429", async () => {
    const { attempts } = await withRetry(
      async () => ({ status: 429, headers: { "retry-after": "1" } }),
      { maxAttempts: 2, baseDelayMs: 9999, maxDelayMs: 10_000 },
    );
    expect(attempts[0].reason).toContain("Retry-After");
    // With retry-after=1s and maxDelay=10s → ~1000ms (jittered)
    expect(attempts[0].delayMs).toBeGreaterThanOrEqual(700);
    expect(attempts[0].delayMs).toBeLessThanOrEqual(1300);
  });

  it("GROVE_NO_RETRY=1 disables retry entirely", async () => {
    process.env.GROVE_NO_RETRY = "1";
    let calls = 0;
    await withRetry(async () => {
      calls++;
      return { status: 429 };
    });
    expect(calls).toBe(1);
  });

  it("disabled option disables retry", async () => {
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        return { status: 429 };
      },
      { disabled: true },
    );
    expect(calls).toBe(1);
  });

  it("returns after a successful retry", async () => {
    let calls = 0;
    const { result, attempts } = await withRetry(
      async () => {
        calls++;
        return { status: calls < 2 ? 429 : 200, headers: { "retry-after": "0" } };
      },
      { baseDelayMs: 1 },
    );
    expect(calls).toBe(2);
    expect(result.status).toBe(200);
    expect(attempts).toHaveLength(1);
  });

  it("caps delay at maxDelayMs even if Retry-After is huge", async () => {
    const { attempts } = await withRetry(
      async () => ({ status: 429, headers: { "retry-after": "3600" } }),
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 100 },
    );
    expect(attempts[0].delayMs).toBeLessThanOrEqual(150); // +jitter
  });
});
