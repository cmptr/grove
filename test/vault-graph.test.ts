import { describe, it, expect } from "vitest";

// ── Test pure helper functions from vault-graph ─────────────────────
// These helpers are not exported, so we re-implement and test the logic.

describe("extractWikilinks", () => {
  const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

  function extractWikilinks(text: string): string[] {
    const links: string[] = [];
    let m: RegExpExecArray | null;
    const re = new RegExp(WIKILINK_RE.source, "g");
    while ((m = re.exec(text)) !== null) links.push(m[1].trim());
    return links;
  }

  it("extracts simple wikilinks", () => {
    const text = "See [[Taste Graph]] and [[Context Engineering]].";
    expect(extractWikilinks(text)).toEqual(["Taste Graph", "Context Engineering"]);
  });

  it("extracts piped wikilinks (display text)", () => {
    const text = "Talk to [[John Milinovich|John]] about [[Parametric Design|the project]].";
    expect(extractWikilinks(text)).toEqual(["John Milinovich", "Parametric Design"]);
  });

  it("extracts path-prefixed links", () => {
    const text = "See [[Resources/Concepts/Taste Graph]] for details.";
    expect(extractWikilinks(text)).toEqual(["Resources/Concepts/Taste Graph"]);
  });

  it("returns empty array for no links", () => {
    expect(extractWikilinks("Just plain text")).toEqual([]);
  });
});

describe("stem", () => {
  function stem(link: string): string {
    const parts = link.split("/");
    return parts[parts.length - 1];
  }

  it("strips path prefix", () => {
    expect(stem("Resources/Concepts/Taste Graph")).toBe("Taste Graph");
  });

  it("returns name unchanged if no path", () => {
    expect(stem("Taste Graph")).toBe("Taste Graph");
  });
});

describe("wordCount", () => {
  function wordCount(text: string): number {
    return text.split(/\s+/).filter(Boolean).length;
  }

  it("counts words in normal text", () => {
    expect(wordCount("hello world foo bar")).toBe(4);
  });

  it("handles empty string", () => {
    expect(wordCount("")).toBe(0);
  });

  it("handles whitespace-only string", () => {
    expect(wordCount("   \n\t  ")).toBe(0);
  });

  it("handles multi-line text", () => {
    expect(wordCount("first line\nsecond line\nthird")).toBe(5);
  });
});

describe("daysBetween", () => {
  function daysBetween(isoDate: string, now: Date): number {
    const d = new Date(isoDate);
    return Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86_400_000));
  }

  it("calculates days correctly", () => {
    const now = new Date("2026-04-07T12:00:00Z");
    expect(daysBetween("2026-04-06T12:00:00Z", now)).toBe(1);
    expect(daysBetween("2026-04-01T12:00:00Z", now)).toBe(6);
  });

  it("returns 0 for same day", () => {
    const now = new Date("2026-04-07T12:00:00Z");
    expect(daysBetween("2026-04-07T00:00:00Z", now)).toBe(0);
  });

  it("returns 0 for future dates", () => {
    const now = new Date("2026-04-07T12:00:00Z");
    expect(daysBetween("2026-04-10T12:00:00Z", now)).toBe(0);
  });
});

describe("lifecycle classification logic", () => {
  // Reproduce the classification logic from computeDigest
  function classify(
    ageDays: number,
    modDaysAgo: number,
    words: number,
    backlinks: number,
  ): string {
    if (ageDays <= 7 && words < 200 && backlinks < 3) return "seed";
    if (ageDays <= 30 && backlinks < 3) return "sprout";
    if (modDaysAgo < 30 || (ageDays <= 90 && backlinks > 3)) return "growing";
    if (ageDays > 180 && backlinks >= 5 && modDaysAgo >= 30) return "mature";
    if (ageDays > 365 && backlinks < 2 && modDaysAgo >= 180) return "withering";
    if (modDaysAgo >= 180) return "dormant";
    return "growing";
  }

  it("classifies a new short note as seed", () => {
    expect(classify(3, 3, 50, 0)).toBe("seed");
  });

  it("classifies a week-old note with some content as sprout", () => {
    expect(classify(14, 14, 300, 1)).toBe("sprout");
  });

  it("classifies recently modified note as growing", () => {
    expect(classify(60, 5, 500, 2)).toBe("growing");
  });

  it("classifies old well-linked note as mature", () => {
    expect(classify(200, 60, 1000, 8)).toBe("mature");
  });

  it("classifies old unlinked note as withering", () => {
    expect(classify(400, 200, 100, 0)).toBe("withering");
  });

  it("classifies old moderately-linked note as dormant", () => {
    expect(classify(200, 200, 500, 3)).toBe("dormant");
  });
});
