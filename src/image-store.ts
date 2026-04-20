/**
 * Cloudflare R2 object storage client.
 *
 * S3-compatible API via AWS Signature V4. Used for image uploads —
 * content-addressed keys (`{vault_id}/{hash}.{ext}`) dedupe identical
 * uploads and the public URL base (assets.grove.md) fronts the bucket.
 *
 * Configuration (env): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME. Optional: R2_PUBLIC_URL.
 */

import { createHash, createHmac } from "node:crypto";

// ── Public interface ───────────────────────────────────────────────

export interface ImageStore {
  upload(key: string, data: Buffer, contentType: string): Promise<{ url: string; size: number }>;
  delete(key: string): Promise<void>;
  getUrl(key: string): string;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Public URL base, e.g. `https://assets.grove.md`. When unset, falls back to the R2 endpoint. */
  publicUrlBase?: string;
}

// ── Config loader ──────────────────────────────────────────────────

export function r2ConfigFromEnv(): R2Config {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;
  const missing: string[] = [];
  if (!accountId) missing.push("R2_ACCOUNT_ID");
  if (!accessKeyId) missing.push("R2_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
  if (!bucket) missing.push("R2_BUCKET_NAME");
  if (missing.length > 0) {
    throw new Error(`Missing R2 config: ${missing.join(", ")}`);
  }
  return {
    accountId: accountId!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    bucket: bucket!,
    publicUrlBase: process.env.R2_PUBLIC_URL,
  };
}

// ── R2 client ──────────────────────────────────────────────────────

type FetchFn = typeof fetch;

export class R2ImageStore implements ImageStore {
  constructor(private readonly cfg: R2Config, private readonly fetchFn: FetchFn = fetch) {}

  private endpoint(): string {
    return `https://${this.cfg.accountId}.r2.cloudflarestorage.com`;
  }

  private signedUrl(key: string): string {
    return `${this.endpoint()}/${this.cfg.bucket}/${encodeKey(key)}`;
  }

  getUrl(key: string): string {
    if (this.cfg.publicUrlBase) {
      return `${this.cfg.publicUrlBase.replace(/\/+$/, "")}/${encodeKey(key)}`;
    }
    return this.signedUrl(key);
  }

  async upload(key: string, data: Buffer, contentType: string): Promise<{ url: string; size: number }> {
    const url = this.signedUrl(key);
    const headers = signV4({
      method: "PUT",
      url: new URL(url),
      body: data,
      contentType,
      region: "auto",
      service: "s3",
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
    });
    const res = await this.fetchFn(url, { method: "PUT", headers, body: data as unknown as BodyInit });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new Error(`R2 upload failed: ${res.status} ${msg.slice(0, 200)}`);
    }
    return { url: this.getUrl(key), size: data.length };
  }

  async delete(key: string): Promise<void> {
    const url = this.signedUrl(key);
    const headers = signV4({
      method: "DELETE",
      url: new URL(url),
      body: Buffer.alloc(0),
      region: "auto",
      service: "s3",
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
    });
    const res = await this.fetchFn(url, { method: "DELETE", headers });
    if (!res.ok && res.status !== 404) {
      const msg = await res.text().catch(() => "");
      throw new Error(`R2 delete failed: ${res.status} ${msg.slice(0, 200)}`);
    }
  }
}

/** Lazy singleton — constructed on first use so tests can swap via setImageStore. */
let singleton: ImageStore | null = null;

export function getImageStore(): ImageStore {
  if (!singleton) singleton = new R2ImageStore(r2ConfigFromEnv());
  return singleton;
}

export function setImageStore(store: ImageStore | null): void {
  singleton = store;
}

// ── Key encoding ───────────────────────────────────────────────────
// S3 object keys may contain "/" as a path separator; preserve them
// while URI-encoding other reserved characters.

function encodeKey(key: string): string {
  return key.split("/").map(uriEscape).join("/");
}

function uriEscape(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// ── AWS Signature V4 ───────────────────────────────────────────────

interface SignArgs {
  method: string;
  url: URL;
  body: Buffer;
  contentType?: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: Date;
}

export function signV4(args: SignArgs): Record<string, string> {
  const now = args.now ?? new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(args.body);

  const headers: Record<string, string> = {
    host: args.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (args.contentType) headers["content-type"] = args.contentType;

  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${headers[n].trim()}\n`).join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalUri = args.url.pathname
    .split("/")
    .map((seg, i) => (i === 0 ? seg : uriEscape(decodeURIComponent(seg))))
    .join("/");

  const canonicalRequest = [
    args.method,
    canonicalUri,
    "", // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${args.region}/${args.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmacSha256(`AWS4${args.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, args.region);
  const kService = hmacSha256(kRegion, args.service);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const out: Record<string, string> = {
    Authorization: authorization,
    "X-Amz-Date": amzDate,
    "X-Amz-Content-Sha256": payloadHash,
  };
  if (args.contentType) out["Content-Type"] = args.contentType;
  return out;
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function formatAmzDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

// ── Content-addressed key helpers ──────────────────────────────────

/** Compute `{prefix}/{sha256}.{ext}` for content-addressed storage. */
export function contentKey(prefix: string, data: Buffer, ext: string): string {
  const hash = createHash("sha256").update(data).digest("hex");
  const cleanExt = ext.replace(/^\./, "").toLowerCase();
  return `${prefix}/${hash}.${cleanExt}`;
}

/** Extract file extension from content type. Returns null for unsupported types. */
export function extForContentType(contentType: string): string | null {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  return map[contentType.toLowerCase()] ?? null;
}
