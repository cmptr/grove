import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, selectFormat, parseFields, isNullDelimited, sortByPath } from "../../src/cli/lib/format.js";

describe("selectFormat", () => {
  const savedTty = process.stdout.isTTY;
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: savedTty, configurable: true });
  });

  it("explicit --format wins", () => {
    expect(selectFormat({ format: "json" }, true)).toBe("json");
    expect(selectFormat({ format: "jsonl" }, true)).toBe("jsonl");
    expect(selectFormat({ format: "paths" }, false)).toBe("paths");
  });

  it("--json shortcut → json", () => {
    expect(selectFormat({ json: true }, true)).toBe("json");
  });

  it("--jsonl shortcut → jsonl", () => {
    expect(selectFormat({ jsonl: true }, true)).toBe("jsonl");
  });

  it("--paths shortcut → paths", () => {
    expect(selectFormat({ paths: true }, true)).toBe("paths");
  });

  it("TTY default → table", () => {
    expect(selectFormat({}, true)).toBe("table");
  });

  it("non-TTY default → json", () => {
    expect(selectFormat({}, false)).toBe("json");
  });

  it("invalid --format string falls through to default", () => {
    expect(selectFormat({ format: "yaml" }, true)).toBe("table");
    expect(selectFormat({ format: "yaml" }, false)).toBe("json");
  });
});

describe("render json", () => {
  it("renders object as indent-2 JSON", () => {
    const out = render({ a: 1, b: [2, 3] }, { format: "json" });
    expect(out).toContain('"a": 1');
    expect(out).toContain('"b": [');
    // Indent-2
    expect(out).toMatch(/\n  "a":/);
  });

  it("renders array", () => {
    const out = render([{ path: "a" }, { path: "b" }], { format: "json" });
    expect(out.startsWith("[")).toBe(true);
    expect(JSON.parse(out)).toEqual([{ path: "a" }, { path: "b" }]);
  });

  it("applies field selector on array of objects", () => {
    const out = render([{ path: "a", title: "A", extra: "x" }], { format: "json", fields: ["path", "title"] });
    const parsed = JSON.parse(out);
    expect(parsed).toEqual([{ path: "a", title: "A" }]);
  });

  it("applies field selector on single object", () => {
    const out = render({ path: "a", extra: "x" }, { format: "json", fields: ["path"] });
    expect(JSON.parse(out)).toEqual({ path: "a" });
  });
});

describe("render jsonl", () => {
  it("emits one object per line, newline-terminated", () => {
    const out = render([{ a: 1 }, { a: 2 }], { format: "jsonl" });
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ a: 1 });
    expect(JSON.parse(lines[1])).toEqual({ a: 2 });
    expect(out.endsWith("\n")).toBe(true);
  });

  it("single object wraps to one line", () => {
    const out = render({ a: 1 }, { format: "jsonl" });
    expect(out).toBe('{"a":1}\n');
  });

  it("empty array produces empty output", () => {
    const out = render([], { format: "jsonl" });
    expect(out).toBe("");
  });
});

describe("render paths", () => {
  it("extracts path from array of objects", () => {
    const out = render([{ path: "a.md" }, { path: "b.md" }], { format: "paths" });
    expect(out).toBe("a.md\nb.md\n");
  });

  it("accepts array of strings", () => {
    const out = render(["a.md", "b.md"], { format: "paths" });
    expect(out).toBe("a.md\nb.md\n");
  });

  it("unwraps envelope shapes (results/entries/notes/paths)", () => {
    expect(render({ results: [{ path: "a.md" }] }, { format: "paths" })).toBe("a.md\n");
    expect(render({ entries: [{ path: "b.md" }] }, { format: "paths" })).toBe("b.md\n");
    expect(render({ notes: [{ path: "c.md" }] }, { format: "paths" })).toBe("c.md\n");
    expect(render({ paths: ["d.md"] }, { format: "paths" })).toBe("d.md\n");
  });

  it("empty → empty string", () => {
    expect(render([], { format: "paths" })).toBe("");
  });
});

describe("render table", () => {
  it("renders array of objects as aligned table", () => {
    const out = render([{ path: "a", type: "concept" }, { path: "b", type: "person" }], { format: "table" });
    const lines = out.split("\n");
    expect(lines[0]).toContain("path");
    expect(lines[0]).toContain("type");
    expect(lines[1]).toContain("a");
    expect(lines[1]).toContain("concept");
  });

  it("handles primitive array", () => {
    expect(render(["a", "b"], { format: "table" })).toBe("a\nb");
  });

  it("handles empty array", () => {
    expect(render([], { format: "table" })).toBe("(empty)");
  });

  it("renders object as key: value lines", () => {
    const out = render({ ok: true, count: 5 }, { format: "table" });
    expect(out).toContain("ok: true");
    expect(out).toContain("count: 5");
  });
});

describe("parseFields", () => {
  it("returns undefined when no fields flag", () => {
    expect(parseFields({})).toBeUndefined();
  });

  it("parses comma-separated list", () => {
    expect(parseFields({ fields: "path,title" })).toEqual(["path", "title"]);
  });

  it("also accepts --field (singular)", () => {
    expect(parseFields({ field: "path" })).toEqual(["path"]);
  });

  it("trims whitespace", () => {
    expect(parseFields({ fields: " path , title " })).toEqual(["path", "title"]);
  });

  it("filters empty segments", () => {
    expect(parseFields({ fields: "path,,title" })).toEqual(["path", "title"]);
  });
});

describe("isNullDelimited", () => {
  it("accepts -0", () => {
    expect(isNullDelimited({ "0": true })).toBe(true);
  });
  it("accepts --print0", () => {
    expect(isNullDelimited({ print0: true })).toBe(true);
  });
  it("defaults to false", () => {
    expect(isNullDelimited({})).toBe(false);
  });
});

describe("sortByPath", () => {
  it("sorts ascending by path", () => {
    const out = sortByPath([{ path: "b" }, { path: "a" }, { path: "c" }]);
    expect(out.map((x) => x.path)).toEqual(["a", "b", "c"]);
  });

  it("is stable across calls (same input → same output)", () => {
    const input = [{ path: "b" }, { path: "a" }];
    const a = sortByPath(input);
    const b = sortByPath(input);
    expect(a).toEqual(b);
  });

  it("does not mutate input", () => {
    const input = [{ path: "b" }, { path: "a" }];
    const copy = JSON.parse(JSON.stringify(input));
    sortByPath(input);
    expect(input).toEqual(copy);
  });
});
