import { describe, it, expect } from "vitest";

// ── chunkText ───────────────────────────────────────────────────────
// Re-implement the pure chunkText function from embed.ts / embed-single.ts
// for isolated testing.

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 180;

function chunkText(text: string, title: string): { pos: number; text: string }[] {
  const full = title ? `${title}\n\n${text}` : text;
  if (full.length <= CHUNK_SIZE) return [{ pos: 0, text: full }];

  const chunks: { pos: number; text: string }[] = [];
  let start = 0;
  while (start < full.length) {
    let end = Math.min(start + CHUNK_SIZE, full.length);
    if (end < full.length) {
      const sl = full.slice(start, end);
      const lastPara = sl.lastIndexOf("\n\n");
      const lastNl = sl.lastIndexOf("\n");
      if (lastPara > CHUNK_SIZE * 0.5) end = start + lastPara + 2;
      else if (lastNl > CHUNK_SIZE * 0.5) end = start + lastNl + 1;
    }
    chunks.push({ pos: start, text: full.slice(start, end) });
    const nextStart = end - CHUNK_OVERLAP;
    start = nextStart > start ? nextStart : end;
    if (start >= full.length) break;
  }
  return chunks;
}

describe("chunkText", () => {
  it("returns single chunk for short text", () => {
    const chunks = chunkText("Hello world", "Title");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].pos).toBe(0);
    expect(chunks[0].text).toBe("Title\n\nHello world");
  });

  it("prepends title to first chunk", () => {
    const chunks = chunkText("Content", "My Title");
    expect(chunks[0].text).toContain("My Title");
    expect(chunks[0].text).toContain("Content");
  });

  it("handles empty title", () => {
    const chunks = chunkText("Short content", "");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Short content");
  });

  it("splits long text into multiple chunks", () => {
    // Create text longer than CHUNK_SIZE
    const longText = "word ".repeat(500); // ~2500 chars
    const chunks = chunkText(longText, "Title");
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("chunks overlap correctly", () => {
    const longText = "a".repeat(2000);
    const chunks = chunkText(longText, "");

    // With overlap, second chunk should start before first chunk ends
    if (chunks.length >= 2) {
      const firstEnd = chunks[0].pos + chunks[0].text.length;
      const secondStart = chunks[1].pos;
      expect(secondStart).toBeLessThan(firstEnd);
    }
  });

  it("prefers breaking at paragraph boundaries", () => {
    // Create text with a paragraph break in the second half of chunk range
    const firstPart = "a".repeat(800);
    const secondPart = "b".repeat(800);
    const text = firstPart + "\n\n" + secondPart;
    const chunks = chunkText(text, "");

    // First chunk should end at or near the paragraph break
    expect(chunks[0].text).toContain(firstPart);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

// ── float32Buffer ───────────────────────────────────────────────────

describe("float32Buffer", () => {
  function float32Buffer(vec: number[]): Buffer {
    const buf = Buffer.alloc(vec.length * 4);
    for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
    return buf;
  }

  it("creates a buffer of correct size", () => {
    const buf = float32Buffer([1.0, 2.0, 3.0]);
    expect(buf.length).toBe(12); // 3 * 4 bytes
  });

  it("round-trips float values", () => {
    const input = [1.5, -0.5, 0.0, 3.14];
    const buf = float32Buffer(input);

    for (let i = 0; i < input.length; i++) {
      const val = buf.readFloatLE(i * 4);
      expect(val).toBeCloseTo(input[i], 5);
    }
  });

  it("handles empty vector", () => {
    const buf = float32Buffer([]);
    expect(buf.length).toBe(0);
  });
});
