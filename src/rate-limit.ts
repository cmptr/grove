/**
 * Rate limiting (sliding window) and idempotency cache for the Grove MCP server.
 * In-memory, no external dependencies.
 */

// ---------------------------------------------------------------------------
// Rate Limiter — sliding window counter, per API key
// ---------------------------------------------------------------------------

interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

interface RateLimits {
  reads: number;
  writes: number;
  windowMs: number;
}

const DEFAULT_LIMITS: RateLimits = { reads: 120, writes: 20, windowMs: 60_000 };

export class RateLimiter {
  private buckets = new Map<string, number[]>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private limits: RateLimits = DEFAULT_LIMITS) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  check(keyId: string, type: "read" | "write"): RateLimitResult {
    const key = `${keyId}:${type}`;
    const now = Date.now();
    const timestamps = (this.buckets.get(key) ?? []).filter((t) => t > now - this.limits.windowMs);
    const max = type === "read" ? this.limits.reads : this.limits.writes;

    if (timestamps.length >= max) {
      const oldest = timestamps[0]!;
      return { allowed: false, retryAfterMs: oldest + this.limits.windowMs - now };
    }
    return { allowed: true };
  }

  checkWithLimit(keyId: string, type: "read" | "write", maxAllowed: number): RateLimitResult {
    const key = `${keyId}:${type}`;
    const now = Date.now();
    const timestamps = (this.buckets.get(key) ?? []).filter((t) => t > now - this.limits.windowMs);
    if (timestamps.length >= maxAllowed) {
      const oldest = timestamps[0]!;
      return { allowed: false, retryAfterMs: oldest + this.limits.windowMs - now };
    }
    return { allowed: true };
  }

  record(keyId: string, type: "read" | "write"): void {
    const key = `${keyId}:${type}`;
    const now = Date.now();
    const timestamps = this.buckets.get(key) ?? [];
    timestamps.push(now);
    this.buckets.set(key, timestamps);
  }

  /** Stop the background cleanup timer (for graceful shutdown). */
  destroy(): void {
    clearInterval(this.cleanupTimer);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.buckets) {
      const live = timestamps.filter((t) => t > now - this.limits.windowMs);
      if (live.length === 0) this.buckets.delete(key);
      else this.buckets.set(key, live);
    }
  }
}

// ---------------------------------------------------------------------------
// Idempotency Cache — LRU, TTL-bounded
// ---------------------------------------------------------------------------

interface CacheEntry {
  response: unknown;
  expiresAt: number;
}

export class IdempotencyCache {
  private store = new Map<string, CacheEntry>();

  constructor(
    private maxSize: number = 1_000,
    private ttlMs: number = 3_600_000,
  ) {}

  get(key: string): unknown | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Move to end for LRU ordering
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.response;
  }

  set(key: string, response: unknown): void {
    // If already present, refresh it
    this.store.delete(key);
    // Evict oldest if at capacity
    if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value!;
      this.store.delete(oldest);
    }
    this.store.set(key, { response, expiresAt: Date.now() + this.ttlMs });
  }
}
