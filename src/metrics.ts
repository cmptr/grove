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
