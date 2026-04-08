import { describe, it, expect, vi } from "vitest";
import { generateRequestId, structuredLog, log, auditRead, auditWrite, type LogEntry } from "../src/logger.js";

describe("generateRequestId", () => {
  it("returns a 26-character ULID-like string", () => {
    const rid = generateRequestId();
    expect(rid).toHaveLength(26);
    // Should only contain Crockford Base32 chars
    expect(rid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRequestId()));
    expect(ids.size).toBe(100);
  });

  it("IDs are roughly time-sorted (first 10 chars encode timestamp)", () => {
    const id1 = generateRequestId();
    const id2 = generateRequestId();
    // Same millisecond = same prefix, but both should have same leading chars
    expect(id1.slice(0, 8)).toBe(id2.slice(0, 8));
  });
});

describe("structuredLog", () => {
  it("writes JSON to stdout with required fields", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const entry: LogEntry = {
      ts: "2026-04-07T00:00:00.000Z",
      rid: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      level: "info",
      msg: "test message",
    };
    structuredLog(entry);
    expect(spy).toHaveBeenCalledOnce();
    const output = spy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(output.trimEnd());
    expect(parsed.ts).toBe("2026-04-07T00:00:00.000Z");
    expect(parsed.rid).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("test message");
    spy.mockRestore();
  });

  it("includes optional fields when provided", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const entry: LogEntry = {
      ts: "2026-04-07T00:00:00.000Z",
      rid: "test-rid",
      level: "info",
      msg: "tool call",
      tool: "query",
      key_id: "key_abc",
      status: 200,
      duration_ms: 42,
    };
    structuredLog(entry);
    const parsed = JSON.parse((spy.mock.calls[0]![0] as string).trimEnd());
    expect(parsed.tool).toBe("query");
    expect(parsed.key_id).toBe("key_abc");
    expect(parsed.status).toBe(200);
    expect(parsed.duration_ms).toBe(42);
    spy.mockRestore();
  });
});

describe("log convenience", () => {
  it("builds a full entry with timestamp", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    log("warn", "something happened", "rid-123", { status: 500 });
    const parsed = JSON.parse((spy.mock.calls[0]![0] as string).trimEnd());
    expect(parsed.level).toBe("warn");
    expect(parsed.msg).toBe("something happened");
    expect(parsed.rid).toBe("rid-123");
    expect(parsed.status).toBe(500);
    expect(parsed.ts).toBeTruthy();
    spy.mockRestore();
  });
});

describe("audit logging", () => {
  it("auditRead emits structured audit.read entry", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    auditRead("rid-1", "key_abc", "my-key", "get", { file: "test.md" });
    const parsed = JSON.parse((spy.mock.calls[0]![0] as string).trimEnd());
    expect(parsed.msg).toBe("audit.read");
    expect(parsed.key_id).toBe("key_abc");
    expect(parsed.key_name).toBe("my-key");
    expect(parsed.tool).toBe("get");
    expect(parsed.args).toEqual({ file: "test.md" });
    spy.mockRestore();
  });

  it("auditWrite emits structured audit.write entry", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    auditWrite("rid-2", "key_xyz", "writer", "write_note", { path: "test.md" }, { action: "create" });
    const parsed = JSON.parse((spy.mock.calls[0]![0] as string).trimEnd());
    expect(parsed.msg).toBe("audit.write");
    expect(parsed.tool).toBe("write_note");
    spy.mockRestore();
  });
});
