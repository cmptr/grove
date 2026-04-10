/**
 * In-memory metrics collector for Grove.
 *
 * Tracks request counts, latency percentiles, and error rates.
 * Exposed via /metrics endpoint as JSON.
 */

interface MetricBucket {
  count: number;
  errors: number;
  latencies: number[]; // raw ms values, capped at 10000 entries
}

const WINDOW_MS = 60_000 * 60; // 1 hour window
const MAX_LATENCIES = 10_000;

class MetricsCollector {
  private buckets = new Map<string, MetricBucket>();
  private startedAt = new Date().toISOString();
  private totalRequests = 0;
  private totalErrors = 0;

  record(tool: string, latencyMs: number, isError: boolean): void {
    this.totalRequests++;
    if (isError) this.totalErrors++;

    let bucket = this.buckets.get(tool);
    if (!bucket) {
      bucket = { count: 0, errors: 0, latencies: [] };
      this.buckets.set(tool, bucket);
    }
    bucket.count++;
    if (isError) bucket.errors++;
    if (bucket.latencies.length < MAX_LATENCIES) {
      bucket.latencies.push(latencyMs);
    }
  }

  recordRequest(method: string, path: string, status: number, latencyMs: number): void {
    const key = `${method} ${path}`;
    this.record(key, latencyMs, status >= 400);
  }

  getMetrics(): Record<string, unknown> {
    const byTool: Record<string, unknown> = {};
    for (const [tool, bucket] of this.buckets) {
      const sorted = [...bucket.latencies].sort((a, b) => a - b);
      byTool[tool] = {
        count: bucket.count,
        errors: bucket.errors,
        error_rate: bucket.count > 0 ? (bucket.errors / bucket.count) : 0,
        latency_p50: percentile(sorted, 0.5),
        latency_p95: percentile(sorted, 0.95),
        latency_p99: percentile(sorted, 0.99),
      };
    }
    return {
      started_at: this.startedAt,
      uptime_seconds: Math.floor((Date.now() - new Date(this.startedAt).getTime()) / 1000),
      total_requests: this.totalRequests,
      total_errors: this.totalErrors,
      error_rate: this.totalRequests > 0 ? (this.totalErrors / this.totalRequests) : 0,
      by_tool: byTool,
    };
  }

  reset(): void {
    this.buckets.clear();
    this.totalRequests = 0;
    this.totalErrors = 0;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, idx)]!;
}

// Singleton
export const metrics = new MetricsCollector();

/* --- Search-specific analytics --- */

interface SearchEntry {
  query: string;
  result_count: number;
  latency_ms: number;
  timestamp: number;
}

interface SearchStats {
  queries_1h: number;
  avg_latency_ms: number;
  zero_result_rate: number;
  top_queries: string[];
}

const SEARCH_BUFFER_SIZE = 1000;

class SearchTracker {
  private buffer: SearchEntry[] = [];
  private cursor = 0;
  private full = false;

  recordSearch(query: string, resultCount: number, latencyMs: number): void {
    const entry: SearchEntry = {
      query,
      result_count: resultCount,
      latency_ms: latencyMs,
      timestamp: Date.now(),
    };
    this.buffer[this.cursor] = entry;
    this.cursor = (this.cursor + 1) % SEARCH_BUFFER_SIZE;
    if (!this.full && this.cursor === 0) this.full = true;
  }

  getSearchStats(): SearchStats {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const recent: SearchEntry[] = [];

    const len = this.full ? SEARCH_BUFFER_SIZE : this.cursor;
    for (let i = 0; i < len; i++) {
      const entry = this.buffer[i]!;
      if (entry.timestamp >= cutoff) {
        recent.push(entry);
      }
    }

    if (recent.length === 0) {
      return { queries_1h: 0, avg_latency_ms: 0, zero_result_rate: 0, top_queries: [] };
    }

    const totalLatency = recent.reduce((sum, e) => sum + e.latency_ms, 0);
    const zeroCount = recent.filter((e) => e.result_count === 0).length;

    // Top 5 most frequent queries (lowercased, deduplicated)
    const freq = new Map<string, number>();
    for (const e of recent) {
      const key = e.query.toLowerCase();
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
    const topQueries = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([q]) => q);

    return {
      queries_1h: recent.length,
      avg_latency_ms: Math.round(totalLatency / recent.length),
      zero_result_rate: zeroCount / recent.length,
      top_queries: topQueries,
    };
  }

  reset(): void {
    this.buffer = [];
    this.cursor = 0;
    this.full = false;
  }
}

export const searchMetrics = new SearchTracker();
