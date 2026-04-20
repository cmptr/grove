import { describe, it, expect, beforeEach, vi } from "vitest";
import { warnDeprecated, DEPRECATION_REMOVAL_DATE } from "../../src/cli/lib/deprecation.js";

describe("warnDeprecated", () => {
  let writes: string[];
  beforeEach(() => {
    writes = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as unknown as typeof process.stderr.write);
  });

  it("emits warning with concrete removal date", () => {
    warnDeprecated("fake-cmd-a", "grove new-form");
    expect(writes.join("")).toContain("deprecated");
    expect(writes.join("")).toContain("grove new-form");
    expect(writes.join("")).toContain(DEPRECATION_REMOVAL_DATE);
  });

  it("deduplicates repeated calls", () => {
    warnDeprecated("fake-cmd-b", "grove b2");
    warnDeprecated("fake-cmd-b", "grove b2");
    warnDeprecated("fake-cmd-b", "grove b2");
    const count = writes.filter((w) => w.includes("fake-cmd-b")).length;
    expect(count).toBe(1);
  });

  it("goes to stderr, never stdout", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write");
    warnDeprecated("fake-cmd-c", "grove c2");
    expect(stdoutSpy).not.toHaveBeenCalledWith(expect.stringContaining("deprecated"));
  });

  it("removal date is an ISO-like yyyy-mm-dd", () => {
    expect(DEPRECATION_REMOVAL_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
