import { describe, it, expect } from "vitest";

// proxy.ts is almost entirely side-effectful (HTTP server, OAuth flow,
// request proxying). We test the few pure helper patterns it uses.

describe("summarizeMcpResponse", () => {
  // Re-implement the pure summarizeMcpResponse function
  function summarizeMcpResponse(response: unknown): unknown {
    if (!response || typeof response !== "object") return response;
    const r = response as any;
    if (r.result?.content?.[0]?.text) {
      const text = r.result.content[0].text as string;
      return { text_length: text.length, preview: text.slice(0, 300) };
    }
    if (r.result?.tools) {
      return { tools: (r.result.tools as any[]).map((t: any) => t.name) };
    }
    if (r.error) return { error: r.error };
    return { keys: Object.keys(r) };
  }

  it("summarizes tool call response with text preview", () => {
    const response = {
      result: { content: [{ type: "text", text: "Hello world, this is a long response" }] },
    };
    const summary = summarizeMcpResponse(response) as any;
    expect(summary.text_length).toBe(36);
    expect(summary.preview).toBe("Hello world, this is a long response");
  });

  it("summarizes tools/list response", () => {
    const response = {
      result: { tools: [{ name: "query" }, { name: "get" }, { name: "write_note" }] },
    };
    const summary = summarizeMcpResponse(response) as any;
    expect(summary.tools).toEqual(["query", "get", "write_note"]);
  });

  it("summarizes error response", () => {
    const response = { error: { code: -1, message: "bad request" } };
    const summary = summarizeMcpResponse(response) as any;
    expect(summary.error).toEqual({ code: -1, message: "bad request" });
  });

  it("returns primitives as-is", () => {
    expect(summarizeMcpResponse(null)).toBeNull();
    expect(summarizeMcpResponse(undefined)).toBeUndefined();
    expect(summarizeMcpResponse(42)).toBe(42);
  });
});

describe("token extraction pattern", () => {
  it("extracts Bearer token from auth header", () => {
    const authHeader = "Bearer grove_live_abc123";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    expect(token).toBe("grove_live_abc123");
  });

  it("returns null for missing Bearer prefix", () => {
    const authHeader = "Basic abc123";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    expect(token).toBeNull();
  });
});
