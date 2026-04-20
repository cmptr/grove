import { describe, it, expect } from "vitest";
import { formatCrashLog } from "../src/crash-handlers.js";

describe("formatCrashLog", () => {
  it("serializes an Error with name, message, and stack", () => {
    const err = new TypeError("boom");
    const log = formatCrashLog("uncaught.exception", "grove-proxy", err);
    expect(log.msg).toBe("uncaught.exception");
    expect(log.level).toBe("fatal");
    expect(log.process).toBe("grove-proxy");
    expect(log.error.name).toBe("TypeError");
    expect(log.error.message).toBe("boom");
    expect(log.error.stack).toContain("TypeError: boom");
    expect(log.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("handles non-Error rejections by stringifying", () => {
    const log = formatCrashLog("unhandled.rejection", "grove-server", "plain string reason");
    expect(log.msg).toBe("unhandled.rejection");
    expect(log.error.name).toBe("Error");
    expect(log.error.message).toBe("plain string reason");
    expect(log.error.stack).toBeTruthy();
  });

  it("handles undefined rejections without crashing", () => {
    const log = formatCrashLog("unhandled.rejection", "grove-proxy", undefined);
    expect(log.error.message).toBe("undefined");
  });

  it("produces a valid JSON-serializable object", () => {
    const err = new Error("test");
    const log = formatCrashLog("uncaught.exception", "grove-proxy", err);
    expect(() => JSON.stringify(log)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(log));
    expect(parsed.error.message).toBe("test");
  });
});
