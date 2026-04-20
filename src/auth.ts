/**
 * Magic link authentication + session management for Grove.
 *
 * All tokens are stored as SHA-256 hashes — raw tokens are never persisted.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "./db.js";
import { sendMagicLinkEmail } from "./email.js";
import type { IncomingMessage, ServerResponse } from "node:http";

// ── Helpers ─────────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateId(prefix: string): string {
  return prefix + randomBytes(8).toString("hex");
}

// CSRF secret — env var or random per-process (fine for single-instance)
const CSRF_SECRET = process.env.GROVE_CSRF_SECRET ?? randomBytes(32).toString("hex");

// ── Magic Links ─────────────────────────────────────────────────────

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAGIC_LINK_RATE_LIMIT = 3; // per email per 15 min

export interface MagicLinkResult {
  ok: true;
}

export async function requestMagicLink(email: string, baseUrl: string, redirect?: string): Promise<MagicLinkResult> {
  const db = getDb();
  const normalizedEmail = email.toLowerCase().trim();

  // Rate limit: count magic links for this email in the last 15 minutes
  // Use datetime() for consistent SQLite format (created_at uses datetime('now') default)
  const recent = db.prepare(
    "SELECT COUNT(*) as count FROM magic_links WHERE email = ? AND created_at > datetime('now', '-15 minutes')"
  ).get(normalizedEmail) as { count: number };

  if (recent.count >= MAGIC_LINK_RATE_LIMIT) {
    // Always return ok to prevent email enumeration
    return { ok: true };
  }

  // Check if user exists before sending (but still return ok either way)
  const user = db.prepare("SELECT id FROM users WHERE email = ?").get(normalizedEmail);

  const token = randomBytes(32).toString("hex");
  const id = generateId("ml_");

  db.prepare(
    "INSERT INTO magic_links (id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)"
  ).run(
    id,
    normalizedEmail,
    hashToken(token),
    new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString(),
  );

  // Only send the email if the user actually exists
  if (user) {
    let verifyUrl = `${baseUrl}/auth/verify?token=${token}&email=${encodeURIComponent(normalizedEmail)}`;
    if (redirect) {
      verifyUrl += `&redirect=${encodeURIComponent(redirect)}`;
    }
    await sendMagicLinkEmail(normalizedEmail, verifyUrl);
  }

  return { ok: true };
}

// ── Magic Link Verification ─────────────────────────────────────────

export interface VerifyResult {
  sessionToken: string;
  user: { id: string; username: string | null; email: string };
}

export function verifyMagicLink(token: string, email: string, userAgent?: string | null): VerifyResult | null {
  const db = getDb();
  const normalizedEmail = email.toLowerCase().trim();
  const tokenHash = hashToken(token);

  const link = db.prepare(
    "SELECT * FROM magic_links WHERE token_hash = ? AND email = ? AND used_at IS NULL AND expires_at > ?"
  ).get(tokenHash, normalizedEmail, new Date().toISOString()) as {
    id: string; email: string; token_hash: string; expires_at: string; used_at: string | null;
  } | undefined;

  if (!link) return null;

  // Mark as used
  db.prepare("UPDATE magic_links SET used_at = ? WHERE id = ?").run(new Date().toISOString(), link.id);

  // Look up user
  const user = db.prepare("SELECT id, username, email FROM users WHERE email = ?").get(normalizedEmail) as {
    id: string; username: string | null; email: string;
  } | undefined;

  if (!user) return null;

  // Create session (also updates last_login_at)
  const { token: sessionToken } = createSession(user.id, userAgent);

  return { sessionToken, user };
}

// ── Sessions ────────────────────────────────────────────────────────

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;          // 30 days sliding
const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days absolute
const SESSION_REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // refresh when < 7 days left

export function createSession(userId: string, userAgent?: string | null): { token: string; id: string } {
  const db = getDb();
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  const id = generateId("sess_");

  db.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at, absolute_expires_at, last_used_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    userId,
    hashToken(token),
    new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS).toISOString(),
    now.toISOString(),
    userAgent ?? null,
  );

  // Track last login for the user (magic link flow does this in verifyMagicLink,
  // but API key / auth code flows go through createSession directly)
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now.toISOString(), userId);

  return { token, id };
}

/** Resolve the session id attached to a given session token, or null if invalid/expired. */
export function getSessionIdFromToken(token: string): string | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT id FROM sessions WHERE token_hash = ?"
  ).get(hashToken(token)) as { id: string } | undefined;
  return row?.id ?? null;
}

export interface SessionUser {
  id: string;
  username: string | null;
  email: string;
}

export function validateSession(token: string): SessionUser | null {
  const db = getDb();
  const tokenHash = hashToken(token);
  const now = new Date();

  const session = db.prepare(
    "SELECT s.id, s.user_id, s.expires_at, s.absolute_expires_at, u.id as uid, u.username, u.email FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token_hash = ?"
  ).get(tokenHash) as {
    id: string; user_id: string; expires_at: string; absolute_expires_at: string;
    uid: string; username: string | null; email: string;
  } | undefined;

  if (!session) return null;

  const expiresAt = new Date(session.expires_at);
  const absoluteExpiresAt = new Date(session.absolute_expires_at);

  // Check both expiry windows
  if (now > expiresAt || now > absoluteExpiresAt) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
    return null;
  }

  // Sliding refresh: extend if within 7 days of expiry (capped by absolute)
  const msRemaining = expiresAt.getTime() - now.getTime();
  if (msRemaining < SESSION_REFRESH_THRESHOLD_MS) {
    const newExpiry = new Date(Math.min(
      now.getTime() + SESSION_TTL_MS,
      absoluteExpiresAt.getTime(),
    ));
    db.prepare("UPDATE sessions SET expires_at = ?, last_used_at = ? WHERE id = ?").run(
      newExpiry.toISOString(), now.toISOString(), session.id,
    );
  } else {
    db.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?").run(now.toISOString(), session.id);
  }

  return { id: session.uid, username: session.username, email: session.email };
}

export function destroySession(token: string): void {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

// ── CSRF Tokens ─────────────────────────────────────────────────────

const CSRF_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function generateCsrfToken(): string {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = Date.now().toString();
  const hmac = createHmac("sha256", CSRF_SECRET)
    .update(`${nonce}:${timestamp}`)
    .digest("base64url");
  return `${hmac}:${timestamp}:${nonce}`;
}

export function validateCsrfToken(token: string): boolean {
  const parts = token.split(":");
  if (parts.length !== 3) return false;
  const [hmac, timestamp, nonce] = parts;

  // Check expiry
  const ts = Number(timestamp);
  if (isNaN(ts) || Date.now() - ts > CSRF_TTL_MS) return false;

  // Verify HMAC
  const expected = createHmac("sha256", CSRF_SECRET)
    .update(`${nonce}:${timestamp}`)
    .digest("base64url");

  // Constant-time comparison
  if (hmac!.length !== expected.length) return false;
  const a = Buffer.from(hmac!);
  const b = Buffer.from(expected);
  return timingSafeEqual(a, b);
}

// ── Cookie Helpers ──────────────────────────────────────────────────

const COOKIE_NAME = "grove_session";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

export function setSessionCookie(res: ServerResponse, token: string): void {
  const secure = (process.env.GROVE_URL ?? "").startsWith("https");
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    `SameSite=Lax`,
    `Max-Age=${COOKIE_MAX_AGE}`,
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(res: ServerResponse): void {
  const secure = (process.env.GROVE_URL ?? "").startsWith("https");
  const parts = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function getSessionFromCookie(req: IncomingMessage): string | null {
  const cookies = req.headers.cookie ?? "";
  const match = cookies.match(/grove_session=([a-f0-9]+)/);
  return match ? match[1]! : null;
}

// ── Auth Codes (cross-domain exchange) ─────────────────────────────

export function createAuthCode(userId: string): string {
  const db = getDb();
  const code = randomBytes(32).toString("hex");
  const id = generateId("ac_");

  db.prepare(
    "INSERT INTO auth_codes (id, code_hash, user_id, expires_at) VALUES (?, ?, ?, ?)"
  ).run(
    id,
    hashToken(code),
    userId,
    new Date(Date.now() + 60_000).toISOString(),  // 60 second TTL
  );

  return code;
}

export function exchangeAuthCode(code: string, userAgent?: string | null): { sessionToken: string; user: SessionUser } | null {
  const db = getDb();
  const codeHash = hashToken(code);

  const row = db.prepare(
    "SELECT ac.id, ac.user_id, ac.expires_at, ac.used_at, u.id as uid, u.username, u.email FROM auth_codes ac JOIN users u ON ac.user_id = u.id WHERE ac.code_hash = ?"
  ).get(codeHash) as {
    id: string; user_id: string; expires_at: string; used_at: string | null;
    uid: string; username: string | null; email: string;
  } | undefined;

  if (!row) return null;
  if (row.used_at) return null;
  if (new Date() > new Date(row.expires_at)) return null;

  // Mark as used
  db.prepare("UPDATE auth_codes SET used_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);

  // Create a session for this user
  const { token: sessionToken } = createSession(row.user_id, userAgent);

  return {
    sessionToken,
    user: { id: row.uid, username: row.username, email: row.email },
  };
}

// ── Cleanup ─────────────────────────────────────────────────────────

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function cleanupExpiredAuth(): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("DELETE FROM magic_links WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM sessions WHERE expires_at < ? OR absolute_expires_at < ?").run(now, now);
  db.prepare("DELETE FROM auth_codes WHERE expires_at < ?").run(now);

  // Start hourly cleanup if not already running
  if (!cleanupInterval) {
    cleanupInterval = setInterval(() => {
      const d = getDb();
      const n = new Date().toISOString();
      d.prepare("DELETE FROM magic_links WHERE expires_at < ?").run(n);
      d.prepare("DELETE FROM sessions WHERE expires_at < ? OR absolute_expires_at < ?").run(n, n);
      d.prepare("DELETE FROM auth_codes WHERE expires_at < ?").run(n);
    }, 60 * 60 * 1000);
  }
}

/** Stop the cleanup interval (for tests). */
export function stopCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// ── Admin Email Seeding ─────────────────────────────────────────────

export function seedAdminEmail(): void {
  const adminEmail = process.env.GROVE_ADMIN_EMAIL;
  if (!adminEmail) return;

  const db = getDb();
  const normalized = adminEmail.toLowerCase().trim();

  // Update admin user's email if it differs
  const admin = db.prepare("SELECT id, email FROM users WHERE id = 'user_00000000'").get() as {
    id: string; email: string;
  } | undefined;

  if (admin && admin.email !== normalized) {
    db.prepare("UPDATE users SET email = ? WHERE id = ?").run(normalized, admin.id);
    console.log(`[auth] Admin email updated to ${normalized}`);
  }
}
