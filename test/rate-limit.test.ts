import { describe, it, expect, afterEach, vi } from "vitest";
import { RateLimiter, IdempotencyCache } from "../src/rate-limit.js";

// ── RateLimiter ─────────────────────────────────────────────────────

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.destroy();
  });

  it("allows requests within the limit", () => {
    limiter = new RateLimiter({ reads: 3, writes: 2, windowMs: 60_000 });

    for (let i = 0; i < 3; i++) {
      expect(limiter.check("key1", "read").allowed).toBe(true);
      limiter.record("key1", "read");
    }
  });

  it("rejects requests over the limit", () => {
    limiter = new RateLimiter({ reads: 2, writes: 1, windowMs: 60_000 });

    limiter.record("key1", "write");
    limiter.record("key1", "write");

    const result = limiter.check("key1", "write");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("separates read and write buckets", () => {
    limiter = new RateLimiter({ reads: 1, writes: 1, windowMs: 60_000 });

    limiter.record("key1", "read");
    // Write bucket should still be open
    expect(limiter.check("key1", "write").allowed).toBe(true);
    // Read bucket should be full
    expect(limiter.check("key1", "read").allowed).toBe(false);
  });

  it("window resets after expiry", () => {
    vi.useFakeTimers();
    try {
      limiter = new RateLimiter({ reads: 1, writes: 1, windowMs: 1_000 });

      limiter.record("key1", "read");
      expect(limiter.check("key1", "read").allowed).toBe(false);

      vi.advanceTimersByTime(1_001);
      expect(limiter.check("key1", "read").allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates different keys", () => {
    limiter = new RateLimiter({ reads: 1, writes: 1, windowMs: 60_000 });

    limiter.record("key1", "read");
    expect(limiter.check("key1", "read").allowed).toBe(false);
    expect(limiter.check("key2", "read").allowed).toBe(true);
  });

  describe("checkWithLimit", () => {
    it("uses custom limit instead of default", () => {
      limiter = new RateLimiter({ reads: 100, writes: 100, windowMs: 60_000 });
      // Custom limit of 3
      for (let i = 0; i < 3; i++) {
        expect(limiter.checkWithLimit("key1", "read", 3).allowed).toBe(true);
        limiter.record("key1", "read");
      }
      expect(limiter.checkWithLimit("key1", "read", 3).allowed).toBe(false);
    });

    it("independent buckets per key", () => {
      limiter = new RateLimiter({ reads: 100, writes: 100, windowMs: 60_000 });
      limiter.record("trail:a", "read");
      limiter.record("trail:a", "read");
      expect(limiter.checkWithLimit("trail:a", "read", 2).allowed).toBe(false);
      expect(limiter.checkWithLimit("trail:b", "read", 2).allowed).toBe(true);
    });
  });

  // Matches the share-mint bucket in src/proxy.ts: 20/hr, keyed per owner userId.
  describe("share mint limiter config (20/hr)", () => {
    it("allows exactly 20 mints, then rejects the 21st", () => {
      limiter = new RateLimiter({ reads: 20, writes: 20, windowMs: 60 * 60 * 1000 });
      for (let i = 0; i < 20; i++) {
        expect(limiter.check("user_owner", "write").allowed).toBe(true);
        limiter.record("user_owner", "write");
      }
      const blocked = limiter.check("user_owner", "write");
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
    });

    it("separates per-owner buckets", () => {
      limiter = new RateLimiter({ reads: 20, writes: 20, windowMs: 60 * 60 * 1000 });
      for (let i = 0; i < 20; i++) limiter.record("user_a", "write");
      expect(limiter.check("user_a", "write").allowed).toBe(false);
      expect(limiter.check("user_b", "write").allowed).toBe(true);
    });
  });

  // Matches the share-view bucket in src/proxy.ts: 60/min, keyed per client IP.
  describe("share view limiter config (60/min)", () => {
    it("allows 60 views from one IP, then rejects the 61st", () => {
      limiter = new RateLimiter({ reads: 60, writes: 60, windowMs: 60_000 });
      for (let i = 0; i < 60; i++) {
        expect(limiter.check("1.2.3.4", "read").allowed).toBe(true);
        limiter.record("1.2.3.4", "read");
      }
      expect(limiter.check("1.2.3.4", "read").allowed).toBe(false);
    });

    it("window rolls over after 60s", () => {
      vi.useFakeTimers();
      try {
        limiter = new RateLimiter({ reads: 60, writes: 60, windowMs: 60_000 });
        for (let i = 0; i < 60; i++) limiter.record("1.2.3.4", "read");
        expect(limiter.check("1.2.3.4", "read").allowed).toBe(false);
        vi.advanceTimersByTime(60_001);
        expect(limiter.check("1.2.3.4", "read").allowed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// ── IdempotencyCache ────────────────────────────────────────────────

describe("IdempotencyCache", () => {
  it("stores and retrieves responses", () => {
    const cache = new IdempotencyCache();
    cache.set("req-1", { status: "ok" });
    expect(cache.get("req-1")).toEqual({ status: "ok" });
  });

  it("returns undefined for missing keys", () => {
    const cache = new IdempotencyCache();
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("expires entries after TTL", () => {
    vi.useFakeTimers();
    try {
      const cache = new IdempotencyCache(100, 500); // 500ms TTL
      cache.set("req-1", "hello");
      expect(cache.get("req-1")).toBe("hello");

      vi.advanceTimersByTime(501);
      expect(cache.get("req-1")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts oldest entry at max size", () => {
    const cache = new IdempotencyCache(2, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // should evict "a"

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("refreshes LRU position on get", () => {
    const cache = new IdempotencyCache(2, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // refresh "a", now "b" is oldest
    cache.set("c", 3); // should evict "b"

    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });
});
