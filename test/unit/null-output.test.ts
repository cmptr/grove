import { describe, it, expect } from "vitest";
import { render } from "../../src/cli/lib/format.js";

describe("NUL-terminated paths output", () => {
  it("newline-delimited by default", () => {
    const out = render([{ path: "a.md" }, { path: "b.md" }], { format: "paths" });
    expect(out).toBe("a.md\nb.md\n");
  });

  it("NUL-delimited with -0", () => {
    const out = render([{ path: "a.md" }, { path: "b.md" }], { format: "paths", nullDelimited: true });
    expect(out).toBe("a.md\0b.md\0");
  });

  it("preserves paths containing newlines under -0", () => {
    // Path with an embedded newline — legal on POSIX (though unusual).
    const weird = "weird\nname.md";
    const out = render([{ path: weird }, { path: "ok.md" }], { format: "paths", nullDelimited: true });
    expect(out).toBe(`${weird}\0ok.md\0`);
    expect(out.split("\0")).toContain(weird);
  });

  it("default newline mode corrupts paths with embedded newlines (documents hazard)", () => {
    // This is the documented hazard: bare --format paths cannot roundtrip newlines.
    // Test locks in the behavior so we notice if it ever changes.
    const weird = "weird\nname.md";
    const out = render([{ path: weird }, { path: "ok.md" }], { format: "paths" });
    // Splitting on \n gives THREE fields, not two — the weird path is split.
    expect(out.split("\n").filter((s) => s.length > 0)).toHaveLength(3);
  });

  it("NUL-delimited empty input → empty string", () => {
    expect(render([], { format: "paths", nullDelimited: true })).toBe("");
  });
});
