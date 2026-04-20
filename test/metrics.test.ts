import { describe, it, expect, beforeEach } from "vitest";
import { metrics } from "../src/metrics.js";

describe("MetricsCollector", () => {
  beforeEach(() => {
    metrics.reset();
  });

  it("records and reports tool metrics", () => {
    metrics.record("query", 50, false);
    metrics.record("query", 100, false);
    metrics.record("query", 200, true);
    const m = metrics.getMetrics();
    expect(m.total_requests).toBe(3);
    expect(m.total_errors).toBe(1);
    const byTool = m.by_tool as Record<string, any>;
    expect(byTool.query.count).toBe(3);
    expect(byTool.query.errors).toBe(1);
    expect(byTool.query.latency_p50).toBe(100);
  });

  it("records request metrics by method and path", () => {
    metrics.recordRequest("POST", "/mcp", 200, 30);
    metrics.recordRequest("POST", "/mcp", 500, 80);
    const m = metrics.getMetrics();
    expect(m.total_requests).toBe(2);
    const byTool = m.by_tool as Record<string, any>;
    expect(byTool["POST /mcp"].count).toBe(2);
    expect(byTool["POST /mcp"].errors).toBe(1);
  });

  it("computes percentiles correctly", () => {
    // 100 values: 1, 2, 3, ..., 100
    for (let i = 1; i <= 100; i++) {
      metrics.record("test", i, false);
    }
    const m = metrics.getMetrics();
    const byTool = m.by_tool as Record<string, any>;
    expect(byTool.test.latency_p50).toBe(50);
    expect(byTool.test.latency_p95).toBe(95);
    expect(byTool.test.latency_p99).toBe(99);
  });

  it("reports zero error rate when no requests", () => {
    const m = metrics.getMetrics();
    expect(m.error_rate).toBe(0);
  });

  it("includes uptime_seconds and started_at", () => {
    const m = metrics.getMetrics();
    expect(m.started_at).toBeTruthy();
    expect(typeof m.uptime_seconds).toBe("number");
  });

  it("reset clears all data", () => {
    metrics.record("get", 10, false);
    metrics.reset();
    const m = metrics.getMetrics();
    expect(m.total_requests).toBe(0);
  });
});

describe("Trail metrics", () => {
  beforeEach(() => {
    metrics.reset();
  });

  it("records trail requests with read/write breakdown", () => {
    metrics.recordTrailRequest("trail-abc", false);
    metrics.recordTrailRequest("trail-abc", false);
    metrics.recordTrailRequest("trail-abc", true);

    const bucket = metrics.getTrailMetrics("trail-abc");
    expect(bucket).not.toBeNull();
    expect(bucket!.requests).toBe(3);
    expect(bucket!.reads).toBe(2);
    expect(bucket!.writes).toBe(1);
    expect(bucket!.last_request_at).toBeTruthy();
  });

  it("tracks separate buckets per trail", () => {
    metrics.recordTrailRequest("trail-1", false);
    metrics.recordTrailRequest("trail-2", true);

    expect(metrics.getTrailMetrics("trail-1")?.requests).toBe(1);
    expect(metrics.getTrailMetrics("trail-2")?.requests).toBe(1);
    expect(metrics.getTrailMetrics("trail-3")).toBeNull();
  });

  it("includes by_trail in getMetrics output", () => {
    metrics.recordTrailRequest("trail-xyz", false);
    const m = metrics.getMetrics();
    const byTrail = m.by_trail as Record<string, any>;
    expect(byTrail["trail-xyz"]).toBeDefined();
    expect(byTrail["trail-xyz"].requests).toBe(1);
  });

  it("reset clears trail buckets", () => {
    metrics.recordTrailRequest("trail-abc", false);
    metrics.reset();
    expect(metrics.getTrailMetrics("trail-abc")).toBeNull();
    const m = metrics.getMetrics();
    expect(Object.keys((m.by_trail as Record<string, unknown>)).length).toBe(0);
  });
});
