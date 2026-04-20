import { describe, it, expect } from "vitest";
import { parseMultipart, parseBoundary } from "../src/multipart.js";

function build(parts: string[]): Buffer {
  return Buffer.concat(parts.map((p) => Buffer.from(p, "binary")));
}

describe("parseBoundary", () => {
  it("extracts boundary from Content-Type header", () => {
    expect(parseBoundary("multipart/form-data; boundary=abc123")).toBe("abc123");
    expect(parseBoundary('multipart/form-data; boundary="quoted-boundary"')).toBe("quoted-boundary");
  });

  it("returns null when missing", () => {
    expect(parseBoundary(undefined)).toBeNull();
    expect(parseBoundary("application/json")).toBeNull();
  });
});

describe("parseMultipart", () => {
  it("parses a single file field and string fields", () => {
    const boundary = "X";
    const body = build([
      "--X\r\n",
      'Content-Disposition: form-data; name="file"; filename="foo.png"\r\n',
      "Content-Type: image/png\r\n",
      "\r\n",
      "\x89PNG\r\n\x1a\n",
      "\r\n--X\r\n",
      'Content-Disposition: form-data; name="tags"\r\n',
      "\r\n",
      "ai,architecture",
      "\r\n--X--\r\n",
    ]);
    const fields = parseMultipart(body, boundary);
    expect(fields).toHaveLength(2);

    const file = fields.find((f) => f.name === "file")!;
    expect(file.filename).toBe("foo.png");
    expect(file.contentType).toBe("image/png");
    expect(file.data.slice(0, 4).toString("binary")).toBe("\x89PNG");

    const tags = fields.find((f) => f.name === "tags")!;
    expect(tags.data.toString("utf-8")).toBe("ai,architecture");
  });

  it("preserves binary payload bytes exactly", () => {
    const boundary = "B";
    const payload = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x42, 0x2d, 0x2d, 0xbe, 0xef]);
    const body = Buffer.concat([
      Buffer.from("--B\r\n"),
      Buffer.from('Content-Disposition: form-data; name="file"; filename="b.bin"\r\n'),
      Buffer.from("Content-Type: application/octet-stream\r\n\r\n"),
      payload,
      Buffer.from("\r\n--B--\r\n"),
    ]);
    const [file] = parseMultipart(body, boundary);
    expect(file.data.equals(payload)).toBe(true);
  });

  it("throws on missing boundary", () => {
    expect(() => parseMultipart(Buffer.from("nothing"), "X")).toThrow(/boundary not found/);
  });
});
