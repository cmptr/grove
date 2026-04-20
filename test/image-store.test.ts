import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { R2ImageStore, contentKey, extForContentType, signV4, r2ConfigFromEnv } from "../src/image-store.js";

const cfg = {
  accountId: "acc123",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "SECRETEXAMPLE",
  bucket: "grove-images",
  publicUrlBase: "https://assets.grove.md",
};

function okResponse(): Response {
  return new Response("", { status: 200 });
}

describe("r2ConfigFromEnv", () => {
  const original = { ...process.env };
  beforeEach(() => {
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_BUCKET_NAME;
    delete process.env.R2_PUBLIC_URL;
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("throws a clear error listing missing env vars", () => {
    expect(() => r2ConfigFromEnv()).toThrow(/R2_ACCOUNT_ID.*R2_ACCESS_KEY_ID.*R2_SECRET_ACCESS_KEY.*R2_BUCKET_NAME/s);
  });

  it("returns config when all vars set", () => {
    process.env.R2_ACCOUNT_ID = "a";
    process.env.R2_ACCESS_KEY_ID = "k";
    process.env.R2_SECRET_ACCESS_KEY = "s";
    process.env.R2_BUCKET_NAME = "b";
    process.env.R2_PUBLIC_URL = "https://assets.grove.md/";
    const c = r2ConfigFromEnv();
    expect(c).toMatchObject({ accountId: "a", accessKeyId: "k", secretAccessKey: "s", bucket: "b" });
    expect(c.publicUrlBase).toBe("https://assets.grove.md/");
  });
});

describe("contentKey + extForContentType", () => {
  it("produces `{prefix}/{sha256}.{ext}` keys", () => {
    const buf = Buffer.from("hello");
    const key = contentKey("life", buf, "png");
    expect(key).toMatch(/^life\/[a-f0-9]{64}\.png$/);
  });

  it("normalizes extension (lowercase, no leading dot)", () => {
    expect(contentKey("life", Buffer.from("x"), ".PNG")).toMatch(/\.png$/);
  });

  it("identical buffers produce identical keys (content-addressed)", () => {
    const a = contentKey("life", Buffer.from([1, 2, 3]), "png");
    const b = contentKey("life", Buffer.from([1, 2, 3]), "png");
    expect(a).toBe(b);
  });

  it("different buffers produce different keys", () => {
    const a = contentKey("life", Buffer.from([1, 2, 3]), "png");
    const b = contentKey("life", Buffer.from([1, 2, 4]), "png");
    expect(a).not.toBe(b);
  });

  it("maps common content types to extensions", () => {
    expect(extForContentType("image/png")).toBe("png");
    expect(extForContentType("image/jpeg")).toBe("jpg");
    expect(extForContentType("image/webp")).toBe("webp");
    expect(extForContentType("image/gif")).toBe("gif");
    expect(extForContentType("IMAGE/PNG")).toBe("png");
  });

  it("returns null for unsupported types", () => {
    expect(extForContentType("application/pdf")).toBeNull();
    expect(extForContentType("text/plain")).toBeNull();
  });
});

describe("signV4", () => {
  it("produces well-formed Authorization header with required components", () => {
    const headers = signV4({
      method: "PUT",
      url: new URL("https://acc123.r2.cloudflarestorage.com/grove-images/life/abc.png"),
      body: Buffer.from("hello"),
      contentType: "image/png",
      region: "auto",
      service: "s3",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "SECRETEXAMPLE",
      now: new Date("2026-04-20T12:00:00Z"),
    });
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(headers.Authorization).toContain("Credential=AKIAEXAMPLE/20260420/auto/s3/aws4_request");
    expect(headers.Authorization).toMatch(/SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date/);
    expect(headers.Authorization).toMatch(/Signature=[a-f0-9]{64}/);
    expect(headers["X-Amz-Date"]).toBe("20260420T120000Z");
    expect(headers["X-Amz-Content-Sha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect(headers["Content-Type"]).toBe("image/png");
  });

  it("deterministic signatures for identical inputs", () => {
    const args = {
      method: "PUT",
      url: new URL("https://acc123.r2.cloudflarestorage.com/grove-images/life/abc.png"),
      body: Buffer.from("hello"),
      contentType: "image/png",
      region: "auto",
      service: "s3",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "SECRETEXAMPLE",
      now: new Date("2026-04-20T12:00:00Z"),
    };
    expect(signV4(args).Authorization).toBe(signV4(args).Authorization);
  });

  it("different bodies produce different signatures", () => {
    const base = {
      method: "PUT",
      url: new URL("https://acc123.r2.cloudflarestorage.com/grove-images/life/abc.png"),
      contentType: "image/png",
      region: "auto",
      service: "s3",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "SECRETEXAMPLE",
      now: new Date("2026-04-20T12:00:00Z"),
    };
    const a = signV4({ ...base, body: Buffer.from("a") });
    const b = signV4({ ...base, body: Buffer.from("b") });
    expect(a.Authorization).not.toBe(b.Authorization);
    expect(a["X-Amz-Content-Sha256"]).not.toBe(b["X-Amz-Content-Sha256"]);
  });
});

describe("R2ImageStore", () => {
  it("upload() PUTs to the correct bucket/key URL", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const store = new R2ImageStore(cfg, fetchFn as unknown as typeof fetch);

    const data = Buffer.from("png-bytes");
    await store.upload("life/abc.png", data, "image/png");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://acc123.r2.cloudflarestorage.com/grove-images/life/abc.png");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(data);
    expect(init.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(init.headers["Content-Type"]).toBe("image/png");
    expect(init.headers["X-Amz-Content-Sha256"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("upload() returns public URL via configured base", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const store = new R2ImageStore(cfg, fetchFn as unknown as typeof fetch);

    const data = Buffer.from("png");
    const out = await store.upload("life/abc.png", data, "image/png");
    expect(out.url).toBe("https://assets.grove.md/life/abc.png");
    expect(out.size).toBe(data.length);
  });

  it("getUrl() falls back to R2 endpoint when no public URL base configured", () => {
    const store = new R2ImageStore({ ...cfg, publicUrlBase: undefined });
    expect(store.getUrl("life/abc.png")).toBe(
      "https://acc123.r2.cloudflarestorage.com/grove-images/life/abc.png",
    );
  });

  it("upload() throws on non-OK response with readable message", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("AccessDenied", { status: 403 }));
    const store = new R2ImageStore(cfg, fetchFn as unknown as typeof fetch);
    await expect(store.upload("k", Buffer.from("x"), "image/png")).rejects.toThrow(
      /R2 upload failed: 403.*AccessDenied/,
    );
  });

  it("delete() sends DELETE and accepts 404 as success", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 404 }));
    const store = new R2ImageStore(cfg, fetchFn as unknown as typeof fetch);
    await store.delete("life/abc.png"); // should not throw

    expect(fetchFn).toHaveBeenCalledWith(
      "https://acc123.r2.cloudflarestorage.com/grove-images/life/abc.png",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("delete() throws on other 4xx/5xx responses", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("ServerError", { status: 500 }));
    const store = new R2ImageStore(cfg, fetchFn as unknown as typeof fetch);
    await expect(store.delete("k")).rejects.toThrow(/R2 delete failed: 500/);
  });

  it("upload() URL-encodes key segments safely", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const store = new R2ImageStore(cfg, fetchFn as unknown as typeof fetch);
    await store.upload("life/my photo.png", Buffer.from("x"), "image/png");
    const [url] = fetchFn.mock.calls[0];
    expect(url).toBe("https://acc123.r2.cloudflarestorage.com/grove-images/life/my%20photo.png");
  });

  it("identical payloads + keys → identical requests (dedupe)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const store = new R2ImageStore(cfg, fetchFn as unknown as typeof fetch);
    const data = Buffer.from("same-bytes");
    const key = contentKey("life", data, "png");
    await store.upload(key, data, "image/png");
    await store.upload(key, data, "image/png");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0][0]).toBe(fetchFn.mock.calls[1][0]);
  });
});
