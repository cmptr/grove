/**
 * Structured JSON logger for Grove.
 *
 * Every log line is a JSON object to stdout with required fields:
 *   ts, rid, level, msg
 * Plus optional: tool, key_id, status, duration_ms, method, path
 *
 * Correlation IDs (rid) are ULIDs — monotonic, sortable, unique per request.
 * The proxy generates the rid and passes it to the server via X-Request-Id header.
 */

import { randomBytes } from "node:crypto";

// ── ULID-like request ID generator ─────────────────────────────────
// Encodes timestamp in first 10 chars (Crockford Base32), random in last 16.
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateRequestId(): string {
  const now = Date.now();
  let ts = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = ENCODING[t & 31] + ts;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(10);
  let r = "";
  for (let i = 0; i < 16; i++) {
    r += ENCODING[rand[i % 10]! & 31];
  }
  return ts + r;
}

// ── Log levels ─────────────────────────────────────────────────────
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  rid: string;
  level: LogLevel;
  msg: string;
  tool?: string;
  key_id?: string;
  key_name?: string;
  status?: number;
  duration_ms?: number;
  method?: string;
  path?: string;
  mcp_method?: string;
  [key: string]: unknown;
}

/** Emit a structured JSON log line to stdout */
export function structuredLog(entry: LogEntry): void {
  process.stdout.write(JSON.stringify(entry) + "\n");
}

/** Convenience: build and emit a log entry */
export function log(
  level: LogLevel,
  msg: string,
  rid: string,
  extra?: Partial<Omit<LogEntry, "ts" | "rid" | "level" | "msg">>,
): void {
  structuredLog({
    ts: new Date().toISOString(),
    rid,
    level,
    msg,
    ...extra,
  });
}

// ── Read audit log ─────────────────────────────────────────────────
// Records every read access with key identity for compliance/audit.
// Written as structured log entries with level "info" and msg "audit.read".

export function auditRead(rid: string, keyId: string, keyName: string, tool: string, args: unknown): void {
  structuredLog({
    ts: new Date().toISOString(),
    rid,
    level: "info",
    msg: "audit.read",
    key_id: keyId,
    key_name: keyName,
    tool,
    args: args as Record<string, unknown>,
  });
}

export function auditWrite(rid: string, keyId: string, keyName: string, tool: string, args: unknown, result: unknown): void {
  structuredLog({
    ts: new Date().toISOString(),
    rid,
    level: "info",
    msg: "audit.write",
    key_id: keyId,
    key_name: keyName,
    tool,
    args: args as Record<string, unknown>,
    result: result as Record<string, unknown>,
  });
}

/**
 * Audit log entry for a user-level account change (e.g. handle change).
 * Unlike {@link auditRead}/{@link auditWrite} the actor here is a user, not
 * an API key — so the payload is keyed on `user_id` rather than `key_id`.
 */
export function auditUserAction(
  rid: string,
  userId: string,
  action: string,
  details: Record<string, unknown>,
): void {
  structuredLog({
    ts: new Date().toISOString(),
    rid,
    level: "info",
    msg: "audit.user",
    user_id: userId,
    action,
    ...details,
  });
}
