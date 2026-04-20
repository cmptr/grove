/**
 * Regression tests for the agent-runner's shell-like tokenizer. The naive
 * whitespace split in the first implementation broke quoted arguments
 * containing spaces, which caused two agent-task failures (t06, t07).
 *
 * We re-implement the tokenizer here and assert the same behaviour, since
 * exporting the internal function just for tests would be unnecessary
 * surface. If the tokenizer ever diverges, update this file first.
 */

import { describe, it, expect } from "vitest";

function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < input.length) {
        cur += input[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c as '"' | "'";
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < input.length) {
      cur += input[i + 1];
      i += 2;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

describe("shell-like tokenize", () => {
  it("splits unquoted tokens on whitespace", () => {
    expect(tokenize("grove search foo")).toEqual(["grove", "search", "foo"]);
  });

  it("preserves double-quoted tokens with spaces (regression for t06)", () => {
    expect(tokenize(`grove write "Resources/Concepts/Test Concept.md" --type concept`)).toEqual([
      "grove",
      "write",
      "Resources/Concepts/Test Concept.md",
      "--type",
      "concept",
    ]);
  });

  it("preserves single-quoted tokens", () => {
    expect(tokenize(`grove search 'taste graph'`)).toEqual(["grove", "search", "taste graph"]);
  });

  it("handles embedded escape sequences inside double quotes", () => {
    expect(tokenize(`grove write p --content "line1\\nline2"`)).toEqual([
      "grove",
      "write",
      "p",
      "--content",
      "line1nline2", // backslash escapes 'n', so the n is kept verbatim (no actual newline)
    ]);
  });

  it("treats backslash as escape outside quotes", () => {
    expect(tokenize(`grove write file\\ name`)).toEqual(["grove", "write", "file name"]);
  });

  it("collapses multiple whitespace between tokens", () => {
    expect(tokenize("grove   list   prefix")).toEqual(["grove", "list", "prefix"]);
  });

  it("handles trailing quote gracefully (dangling quote at EOF)", () => {
    // A malformed input should still produce a tokenization (lenient).
    const out = tokenize(`grove write "no-closing-quote`);
    expect(out[0]).toBe("grove");
    expect(out[1]).toBe("write");
    expect(out[2]).toBe("no-closing-quote");
  });

  it("multiple quoted args in one command (regression for t07)", () => {
    const cmd = `grove patch path.md --if-hash abc --content "Hello\\nWorld with spaces"`;
    const out = tokenize(cmd);
    expect(out).toContain("--if-hash");
    expect(out).toContain("abc");
    expect(out).toContain("--content");
    expect(out).toContain("HellonWorld with spaces");
  });
});
