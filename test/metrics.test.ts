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
