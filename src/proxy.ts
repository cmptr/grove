#!/usr/bin/env tsx
/**
 * Grove Phase 0 — Auth proxy for QMD MCP server.
 *
 * Sits in front of QMD's MCP HTTP server (localhost:8181) and validates
 * bearer tokens before forwarding requests. Implements a minimal OAuth 2.0
 * flow so Claude.ai can connect as a custom connector.
 *
 * Usage:
 *   GROVE_PORT=8420 npx tsx src/proxy.ts
 */

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { appendFileSync } from "node:fs";
import { RateLimiter } from "./rate-limit.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { createKey, revokeKey, isExpired, hashToken, updateLastUsed, type StoredKey } from "./keys.js";
import { getDb } from "./db.js";
import { runMigration } from "./db.js";
import {
  requestMagicLink,
  verifyMagicLink,
  validateSession,
  destroySession,
  createSession as createAuthSession,
  createAuthCode,
  exchangeAuthCode,
  generateCsrfToken,
  validateCsrfToken,
  setSessionCookie,
  clearSessionCookie,
  getSessionFromCookie,
  cleanupExpiredAuth,
  seedAdminEmail,
} from "./auth.js";
import { generateRequestId, log as structuredLog, auditRead, auditWrite } from "./logger.js";
import { metrics, searchMetrics } from "./metrics.js";
import { resolveTrail, type TrailConfig } from "./trails.js";
import { handleGetNote, handleSearch, handleListNotes, handleStats } from "./rest.js";
import { startStatsTimer } from "./vault-stats.js";

const QMD_PORT = Number(process.env.QMD_PORT ?? 8181);
const GROVE_SERVER_PORT = Number(process.env.GROVE_SERVER_PORT ?? 8190);
const PROXY_PORT = Number(process.env.GROVE_PORT ?? 8420);
const LOG_DIR = join(homedir(), ".grove");
const LOG_PATH = join(LOG_DIR, "proxy.log");
const MCP_LOG_PATH = join(LOG_DIR, "mcp.jsonl");
const GROVE_URL = process.env.GROVE_URL ?? "https://api.grove.md";

const rateLimiter = new RateLimiter({ reads: 120, writes: 20, windowMs: 60_000 });

// ── Admin auth: persistent session cookie (SQLite) + Bearer fallback ──
const GROVE_ADMIN_KEY = process.env.GROVE_ADMIN_KEY; // optional: restrict admin to a specific key name

function adminAuth(req: IncomingMessage): { keyId: string; keyName: string } | null {
  // Check session cookie first (persistent in SQLite)
  const sessionToken = getSessionFromCookie(req);
  if (sessionToken) {
    const user = validateSession(sessionToken);
    if (user) {
      return { keyId: user.id, keyName: user.username ?? user.email };
    }
  }
  // Fall back to Bearer token
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;
  const key = validateToken(token);
  if (!key) return null;
  // Optionally restrict admin to a specific key
  if (GROVE_ADMIN_KEY && key.name !== GROVE_ADMIN_KEY) return null;
  return { keyId: key.id, keyName: key.name };
}

function validateToken(token: string): StoredKey | null {
  const hash = hashToken(token);
  const db = getDb();
  const key = db.prepare("SELECT * FROM api_keys WHERE hashed_token = ?").get(hash) as StoredKey | null;
  if (!key) return null;
  if (isExpired(key)) return null;
  return key;
}

function log(keyName: string | null, method: string, url: string, status: number, extra?: Record<string, unknown>) {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    key: keyName ?? "unauthenticated",
    method,
    url,
    status,
  };
  if (extra) Object.assign(entry, extra);
  try { appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n"); } catch {
    // Best-effort logging — disk full or permission errors are non-fatal
  }
}

/** Log a full MCP conversation turn: request tool + args, response summary, latency */
function logMcp(keyName: string, sessionId: string | undefined, tool: string, args: unknown, response: unknown, latencyMs: number, status: number) {
  // Record metrics for this tool call
  metrics.record(tool, latencyMs, status >= 400);

  const entry = {
    ts: new Date().toISOString(),
    key: keyName,
    session: sessionId ?? null,
    tool,
    args,
    response: summarizeMcpResponse(response),
    latency_ms: latencyMs,
    status,
  };
  try { appendFileSync(MCP_LOG_PATH, JSON.stringify(entry) + "\n"); } catch {
    // Best-effort logging — disk full or permission errors are non-fatal
  }
}

/** Extract a readable summary from an MCP response for logging */
function summarizeMcpResponse(response: unknown): unknown {
  if (!response || typeof response !== "object") return response;
  const r = response as Record<string, unknown>;
  // tools/call response: { result: { content: [{ type, text }] } }
  const result = r.result as Record<string, unknown> | undefined;
  if (result?.content) {
    const content = result.content as { type: string; text: string }[];
    if (content[0]?.text) {
      const text = content[0].text;
      return { text_length: text.length, preview: text.slice(0, 300) };
    }
  }
  // tools/list response
  if (result?.tools) {
    const tools = result.tools as { name: string }[];
    return { tools: tools.map((t) => t.name) };
  }
  // Error response
  if (r.error) return { error: r.error };
  return { keys: Object.keys(r) };
}

// ── OAuth 2.0 minimal implementation ──
// Claude.ai requires OAuth for custom connectors. This implements
// the bare minimum: authorization code flow with auto-approve.
// The "authorization" just shows a page where you paste your API key.

// ── OAuth encryption helpers ──
// Short-lived AES-256-GCM encryption for API keys stored in oauth_codes.
// Keys are encrypted at code creation and decrypted at token exchange (5min window).
const OAUTH_ENCRYPT_KEY = createHash("sha256").update(process.env.GROVE_CSRF_SECRET ?? "grove-oauth-default").digest();

function encryptForOAuth(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", OAUTH_ENCRYPT_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptForOAuth(encoded: string): string {
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", OAUTH_ENCRYPT_KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

function handleOAuth(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const path = url.pathname;

  // Protected Resource Metadata (RFC 9728) — required by MCP spec
  // Serves at both /mcp-scoped and root paths so clients discover auth regardless of path
  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
    sendJson(res, 200, {
      resource: `${GROVE_URL}/mcp`,
      authorization_servers: [GROVE_URL],
      bearer_methods_supported: ["header"],
      scopes_supported: ["read", "write"],
    });
    return true;
  }

  // OAuth server metadata (RFC 8414)
  if (path === "/.well-known/oauth-authorization-server") {
    sendJson(res, 200, {
      issuer: GROVE_URL,
      authorization_endpoint: `${GROVE_URL}/oauth/authorize`,
      token_endpoint: `${GROVE_URL}/oauth/token`,
      registration_endpoint: `${GROVE_URL}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    });
    return true;
  }

  // Dynamic Client Registration (RFC 7591)
  if (path === "/oauth/register" && req.method === "POST") {
    readBody(req).then((body) => {
      const data = JSON.parse(body);
      const clientId = "grove_client_" + randomBytes(16).toString("hex");
      const clientSecret = "grove_secret_" + randomBytes(32).toString("hex");
      const redirectUris = data.redirect_uris || [];

      const db = getDb();
      db.prepare(
        "INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris) VALUES (?, ?, ?)"
      ).run(clientId, hashToken(clientSecret), JSON.stringify(redirectUris));

      console.log(`OAuth client registered: ${clientId}`);
      sendJson(res, 201, {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: redirectUris,
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      });
    }).catch(() => sendJson(res, 400, { error: "invalid_request" }));
    return true;
  }

  // Authorization endpoint — shows a simple page to paste your API key
  if (path === "/oauth/authorize" && req.method === "GET") {
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const codeChallenge = url.searchParams.get("code_challenge") ?? "";
    const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "";

    const html = `<!DOCTYPE html>
<html><head><title>Grove &mdash; Authorize</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #FAF7F2; color: #2C2416; padding: 20px; }
  .card { width: 100%; max-width: 400px; }
  h1 { font-family: 'Lora', Georgia, serif; font-size: 28px; font-weight: 500; margin-bottom: 8px; letter-spacing: -0.01em; }
  p { color: #2C2416aa; font-size: 14px; line-height: 1.6; margin-bottom: 24px; }
  label { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; color: #2C2416aa; margin-bottom: 8px; }
  input[type=password] { width: 100%; padding: 14px 16px; font-size: 14px; font-family: 'SF Mono', 'Fira Code', monospace; border: 1px solid #2C241620; border-radius: 4px; background: white; color: #2C2416; }
  input[type=password]:focus { outline: none; border-color: #7A8B5C; box-shadow: 0 0 0 3px #7A8B5C20; }
  input[type=password]::placeholder { color: #2C241640; }
  button { width: 100%; padding: 14px; font-size: 14px; font-weight: 600; background: #2C2416; color: #FAF7F2; border: none; border-radius: 4px; cursor: pointer; margin-top: 12px; letter-spacing: 0.02em; transition: background 0.15s; }
  button:hover { background: #3D3524; }
  button:active { transform: scale(0.98); }
  .subtle { font-size: 12px; color: #2C241650; margin-top: 16px; text-align: center; }
  .subtle a { color: #7A8B5C; text-decoration: none; }
  .subtle a:hover { text-decoration: underline; }
</style></head>
<body>
  <div class="card">
    <h1>Grove</h1>
    <p>Paste your API key to connect Claude to your vault.</p>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${clientId}">
      <input type="hidden" name="redirect_uri" value="${redirectUri}">
      <input type="hidden" name="state" value="${state}">
      <input type="hidden" name="code_challenge" value="${codeChallenge}">
      <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">
      <label for="api_key">API key</label>
      <input type="password" id="api_key" name="api_key" placeholder="grove_live_..." required autofocus>
      <button type="submit">Connect</button>
    </form>
    <p class="subtle">Don't have a key? <a href="https://grove.md">Get early access</a></p>
  </div>
</body></html>`;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return true;
  }

  // Authorization endpoint — POST (form submit)
  if (path === "/oauth/authorize" && req.method === "POST") {
    readBody(req).then((body) => {
      const params = new URLSearchParams(body);
      const apiKey = params.get("api_key") ?? "";
      const clientId = params.get("client_id") ?? "";
      const redirectUri = params.get("redirect_uri") ?? "";
      const state = params.get("state") ?? "";
      const codeChallenge = params.get("code_challenge") ?? "";
      const codeChallengeMethod = params.get("code_challenge_method") ?? "";

      // Validate the API key
      const key = validateToken(apiKey);
      if (!key) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:420px;margin:60px auto;padding:0 20px;background:#0a0a0a;color:#e0e0e0;">
          <h1 style="color:#c44;">Invalid API key</h1><p>That key wasn't recognized. <a href="javascript:history.back()" style="color:#4a9;">Try again</a></p></body></html>`);
        return;
      }

      // Generate auth code and store in SQLite
      const codeStr = randomBytes(32).toString("hex");
      const db = getDb();
      db.prepare(
        "INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, key_id, encrypted_key, expires_at, code_challenge, code_challenge_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        hashToken(codeStr),
        clientId,
        redirectUri,
        key.id,
        encryptForOAuth(apiKey),
        new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        codeChallenge || null,
        codeChallengeMethod || null,
      );

      console.log(`OAuth code issued for key: ${key.name}`);

      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", codeStr);
      if (state) redirect.searchParams.set("state", state);
      const callbackUrl = redirect.toString();

      // Non-localhost (e.g. claude.ai) — standard 302
      if (redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1") {
        res.writeHead(302, { Location: callbackUrl });
        res.end();
        return;
      }

      // Localhost — the MCP client should have a callback server running.
      // Serve a success page that redirects via JS. If the client is listening,
      // the redirect completes and the client shows its own close-tab page.
      // If not, the user sees "Authorized" instead of "site can't be reached"
      // and can copy the callback URL to paste into Claude Code manually.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html><head><title>Grove — Authorized</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #FAF7F2; color: #2C2416; padding: 20px; }
  .card { width: 100%; max-width: 400px; text-align: center; }
  .check { color: #7A8B5C; font-size: 48px; margin-bottom: 16px; }
  h1 { font-family: 'Lora', Georgia, serif; font-size: 28px; font-weight: 500; margin-bottom: 8px; letter-spacing: -0.01em; }
  p { color: #2C2416aa; font-size: 14px; line-height: 1.6; margin-bottom: 20px; }
  .url { display: none; padding: 12px 16px; font-size: 12px; font-family: 'SF Mono', 'Fira Code', monospace; background: white; border: 1px solid #2C241620; border-radius: 4px; word-break: break-all; text-align: left; margin: 16px 0; cursor: pointer; user-select: all; }
  .url:hover { border-color: #7A8B5C; }
  .hint { display: none; font-size: 12px; color: #2C241660; }
</style></head>
<body>
  <div class="card">
    <div class="check">&#10003;</div>
    <h1>Authorized</h1>
    <p id="status">Connecting to your client&hellip;</p>
    <div class="url" id="url">${callbackUrl}</div>
    <p class="hint" id="hint">Copy this URL and paste it into Claude Code to complete setup.</p>
  </div>
  <script>
    setTimeout(() => { window.location.href = ${JSON.stringify(callbackUrl)}; }, 600);
    setTimeout(() => {
      // If we're still here after 3s, the redirect didn't work
      document.getElementById("status").textContent = "You can close this tab.";
      document.getElementById("url").style.display = "block";
      document.getElementById("hint").style.display = "block";
    }, 3000);
  </script>
</body></html>`);
    }).catch(() => sendJson(res, 400, { error: "invalid_request" }));
    return true;
  }

  // Token endpoint — exchange code for access token
  if (path === "/oauth/token" && req.method === "POST") {
    readBody(req).then((body) => {
      const params = new URLSearchParams(body);
      const grantType = params.get("grant_type");
      const code = params.get("code") ?? "";
      const codeVerifier = params.get("code_verifier") ?? "";

      if (grantType !== "authorization_code") {
        sendJson(res, 400, { error: "unsupported_grant_type" });
        return;
      }

      const db = getDb();
      const codeHash = hashToken(code);
      const authCode = db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(codeHash) as {
        code_hash: string;
        client_id: string;
        redirect_uri: string;
        key_id: string;
        encrypted_key: string;
        expires_at: string;
        code_challenge: string | null;
        code_challenge_method: string | null;
      } | undefined;

      if (!authCode) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "Code not found" });
        return;
      }

      // Check expiry
      if (new Date(authCode.expires_at).getTime() < Date.now()) {
        db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(codeHash);
        sendJson(res, 400, { error: "invalid_grant", error_description: "Code expired" });
        return;
      }

      // Verify PKCE if code_challenge was provided
      if (authCode.code_challenge && authCode.code_challenge_method === "S256") {
        const expected = createHash("sha256")
          .update(codeVerifier)
          .digest("base64url");
        if (expected !== authCode.code_challenge) {
          sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }
      }

      // Remove used code and decrypt the API key
      db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(codeHash);
      const accessToken = decryptForOAuth(authCode.encrypted_key);

      console.log(`OAuth token issued for code`);

      // Return the original API key as the access token
      sendJson(res, 200, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 86400 * 365, // 1 year — effectively no expiry
      });
    }).catch(() => sendJson(res, 400, { error: "invalid_request" }));
    return true;
  }

  return false;
}

// ── Proxy helpers ──

function proxyToQmd(req: IncomingMessage, res: ServerResponse) {
  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (key === "authorization" || key === "host") continue;
    if (val) headers[key] = Array.isArray(val) ? val.join(", ") : val;
  }

  const proxyReq = httpRequest(
    {
      hostname: "::1",
      port: QMD_PORT,
      path: req.url,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      const resHeaders: Record<string, string | string[]> = {};
      for (const [key, val] of Object.entries(proxyRes.headers)) {
        if (val) resHeaders[key] = val;
      }
      resHeaders["access-control-allow-origin"] = "*";
      resHeaders["access-control-allow-methods"] = "GET, POST, PUT, DELETE, OPTIONS";
      resHeaders["access-control-allow-headers"] =
        "Content-Type, Authorization, mcp-session-id";
      resHeaders["access-control-expose-headers"] = "mcp-session-id";

      res.writeHead(proxyRes.statusCode ?? 200, resHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (err) => {
    console.error("Proxy error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "QMD server unreachable" }));
    }
  });

  req.pipe(proxyReq);
}

function verifyPage(token: string, email: string, csrf: string, redirect: string = ""): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grove — Confirm Sign In</title>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;color:#2C2416;padding:20px}
  .card{width:100%;max-width:400px}
  h1{font-family:'Lora',Georgia,serif;font-size:28px;font-weight:500;margin-bottom:8px;letter-spacing:-0.01em}
  p{color:#2C2416aa;font-size:14px;line-height:1.6;margin-bottom:24px}
  .email{font-weight:600;color:#2C2416}
  button{width:100%;padding:14px;font-size:14px;font-weight:600;background:#2C2416;color:#FAF7F2;border:none;border-radius:4px;cursor:pointer;letter-spacing:0.02em;transition:background 0.15s}
  button:hover{background:#3D3524}
</style></head><body>
<div class="card">
  <h1>Grove</h1>
  <p>Sign in as <span class="email">${email}</span></p>
  <form method="POST" action="/auth/verify">
    <input type="hidden" name="token" value="${token}">
    <input type="hidden" name="email" value="${email}">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="redirect" value="${redirect}">
    <button type="submit">Confirm Sign In</button>
  </form>
</div>
</body></html>`;
}

function setupPage(keyName: string | null): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grove</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 20px;color:#1a1a1a;line-height:1.5}
  h1{font-size:1.4em;margin-bottom:4px}
  .sub{color:#666;margin-bottom:32px;font-size:.9em}
  .section{margin-bottom:28px}
  .section h2{font-size:.85em;text-transform:uppercase;letter-spacing:.05em;color:#888;margin-bottom:8px}
  .endpoint{background:#f5f5f5;padding:12px 16px;border-radius:8px;font-family:monospace;font-size:.9em;word-break:break-all;cursor:pointer;position:relative}
  .endpoint:hover{background:#eee}
  .endpoint::after{content:'copy';position:absolute;right:12px;top:12px;font-family:sans-serif;font-size:.75em;color:#888}
  input,button{font-size:.9em;padding:8px 12px;border-radius:6px;border:1px solid #ddd}
  input{width:100%;margin-bottom:8px}
  button{background:#1a1a1a;color:#fff;border:none;cursor:pointer;padding:8px 20px}
  button:hover{background:#333}
  .key-list{font-size:.85em;margin-top:12px}
  .key-item{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #eee}
  .key-item button{font-size:.75em;padding:4px 10px;background:#c33}
  .token-display{background:#f0f7e6;padding:12px;border-radius:8px;font-family:monospace;font-size:.8em;word-break:break-all;margin-top:8px}
  .note{font-size:.8em;color:#888;margin-top:4px}
  #auth-section{margin-bottom:28px}
  #authed{display:none}
</style></head><body>
<h1>Grove</h1>
<p class="sub">Knowledge API for your Obsidian vault</p>

<div class="section">
  <h2>MCP Endpoint</h2>
  <div class="endpoint" onclick="navigator.clipboard.writeText('${GROVE_URL}/mcp')">${GROVE_URL}/mcp</div>
  <p class="note">Use this URL when adding Grove as an MCP connector in Claude.ai, Cursor, or any MCP client.</p>
</div>

<div id="auth-section">
  <div class="section">
    <h2>Sign in with Email</h2>
    <input type="email" id="email-input" placeholder="you@example.com" />
    <button onclick="magicLink()">Send magic link</button>
    <div id="magic-link-msg" style="display:none" class="note"></div>
  </div>
  <div class="section">
    <h2>Or use an API key</h2>
    <input type="password" id="token-input" placeholder="Paste your API key (grove_live_...)" />
    <button onclick="auth()">Sign in</button>
    <p class="note">Need a key? Run <code>grove keys create my-key</code> from any device with an existing key.</p>
  </div>
</div>

<div id="authed">
  <div class="section">
    <h2>Create API Key</h2>
    <input type="text" id="key-name" placeholder="Key name (e.g., phone, laptop, cli)" />
    <button onclick="createKey()">Create</button>
    <div id="new-token" style="display:none">
      <div class="token-display" id="token-value"></div>
      <p class="note">Save this now — it won't be shown again.</p>
    </div>
  </div>
  <div class="section">
    <h2>API Keys</h2>
    <div id="key-list" class="key-list">Loading...</div>
  </div>
</div>

<script>
let bearerToken = null;
// Check for existing session on page load
fetch('/auth/session').then(r => r.ok ? r.json() : null).then(d => {
  if (d && d.user) {
    document.getElementById('auth-section').style.display = 'none';
    document.getElementById('authed').style.display = 'block';
    loadKeys();
  }
});
function magicLink() {
  const email = document.getElementById('email-input').value.trim();
  if (!email) return;
  const msg = document.getElementById('magic-link-msg');
  fetch('/auth/magic-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  }).then(r => r.json()).then(() => {
    msg.textContent = 'Check your email for a sign-in link.';
    msg.style.display = 'block';
  });
}
function auth() {
  bearerToken = document.getElementById('token-input').value.trim();
  if (!bearerToken) return;
  fetch('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: bearerToken }),
  }).then(r => {
    if (r.ok) {
      document.getElementById('auth-section').style.display = 'none';
      document.getElementById('authed').style.display = 'block';
      loadKeys();
    }
  });
}
function authHeaders() {
  var h = { 'Content-Type': 'application/json' };
  if (bearerToken) h['Authorization'] = 'Bearer ' + bearerToken;
  return h;
}
function loadKeys() {
  fetch('/keys', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ action: 'list' }),
  }).then(r => r.json()).then(d => {
    const keys = d.keys || [];
    if (keys.length === 0) {
      document.getElementById('key-list').innerHTML = '<p class="note">No keys.</p>';
      return;
    }
    document.getElementById('key-list').innerHTML = keys.map(k =>
      '<div class="key-item"><span>' + k.name + ' <span class="note">(' + k.id + ', ' + (k.scopes||[]).join(',') + ')</span></span>' +
      '<button onclick="revokeKey(\\'' + k.id + '\\')">Revoke</button></div>'
    ).join('');
  });
}
function revokeKey(id) {
  if (!confirm('Revoke key ' + id + '?')) return;
  fetch('/keys', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ action: 'revoke', id }),
  }).then(() => loadKeys());
}
function createKey() {
  const name = document.getElementById('key-name').value.trim();
  if (!name) return;
  fetch('/keys', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ action: 'create', name }),
  }).then(r => r.json()).then(d => {
    if (d.token) {
      document.getElementById('token-value').textContent = d.token;
      document.getElementById('new-token').style.display = 'block';
      document.getElementById('key-name').value = '';
    }
  });
}
</script>
</body></html>`;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const MAX_BODY = 1048576; // 1MB body size limit

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

/** Proxy a request to QMD and return the full response body as a string */
function proxyAndCapture(hostname: string, port: number, origReq: IncomingMessage, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proxyReq = httpRequest(
      {
        hostname,
        port,
        path: origReq.url,
        method: origReq.method,
        headers: (() => {
          const h: Record<string, string> = {
            "Accept": "application/json, text/event-stream",
          };
          for (const [k, v] of Object.entries(origReq.headers)) {
            if (k === "authorization" || k === "host") continue;
            if (v) h[k] = Array.isArray(v) ? v.join(", ") : v;
          }
          return h;
        })(),
      },
      (proxyRes) => {
        let data = "";
        proxyRes.on("data", (c) => (data += c));
        proxyRes.on("end", () => resolve(data));
      }
    );
    proxyReq.on("error", reject);
    proxyReq.write(body);
    proxyReq.end();
  });
}

// ── Main server ──

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PROXY_PORT}`);
  const rid = (req.headers["x-request-id"] as string) ?? generateRequestId();
  res.setHeader("X-Request-Id", rid);

  // CORS preflight — /v1/* gets locked-down CORS (handled in the /v1/ block below),
  // everything else gets permissive CORS for MCP/Claude.ai compatibility
  if (req.method === "OPTIONS" && !url.pathname.startsWith("/v1/")) {
    // Lock down cookie-auth routes; keep * for Bearer-only routes (MCP, search)
    const isCookieRoute = url.pathname.startsWith("/auth") ||
      url.pathname.startsWith("/admin") ||
      url.pathname === "/keys" ||
      url.pathname === "/";
    const corsOrigin = isCookieRoute ? GROVE_URL : "*";
    res.writeHead(204, {
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
      "Access-Control-Expose-Headers": "mcp-session-id",
    });
    res.end();
    return;
  }

  // OAuth endpoints (unauthenticated)
  if (handleOAuth(req, res, url)) return;

  // Deep health check — verifies downstream services (QMD, Grove server, embed)
  if (url.pathname === "/health") {
    const checks: Record<string, boolean> = { proxy: true };
    const checkServer = (hostname: string, port: number, path: string) =>
      new Promise<boolean>((resolve) => {
        const r = httpRequest({ hostname, port, path, method: "GET", timeout: 3000 }, (res) => {
          res.resume();
          resolve((res.statusCode ?? 500) < 400);
        });
        r.on("error", () => resolve(false));
        r.on("timeout", () => { r.destroy(); resolve(false); });
        r.end();
      });
    const [groveOk, qmdOk] = await Promise.all([
      checkServer("127.0.0.1", GROVE_SERVER_PORT, "/health"),
      checkServer("127.0.0.1", 8177, "/health"), // BM25 search server (QMD companion)
    ]);
    // Embed health: just check that VOYAGE_API_KEY is set (API is external)
    const embedOk = !!process.env.VOYAGE_API_KEY;
    checks["grove-server"] = groveOk;
    checks.qmd = qmdOk;
    checks.embed = embedOk;
    const allOk = groveOk && qmdOk;
    sendJson(res, allOk ? 200 : 503, { ok: allOk, checks });
    return;
  }

  // Metrics endpoint — request counts, latency percentiles, error rates
  if (url.pathname === "/metrics") {
    const admin = adminAuth(req);
    if (!admin) { sendJson(res, 401, { error: "unauthorized" }); return; }
    res.setHeader("Access-Control-Allow-Origin", GROVE_URL);
    sendJson(res, 200, { ...metrics.getMetrics(), search: searchMetrics.getSearchStats() });
    return;
  }

  // ── Admin login (POST /admin/login — creates persistent session cookie) ──
  if (url.pathname === "/admin/login" && req.method === "POST") {
    let body: string;
    try { body = await readBody(req); } catch { sendJson(res, 400, { error: "read error" }); return; }
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { sendJson(res, 400, { error: "invalid json" }); return; }
    const apiKey = parsed.api_key ?? "";
    const key = validateToken(apiKey);
    if (!key) { sendJson(res, 401, { error: "invalid key" }); return; }
    // Find the user who owns this key and create a persistent session
    const keyOwner = getDb().prepare("SELECT id FROM users WHERE id = ?").get(key.user_id) as { id: string } | undefined;
    const sessionToken = createAuthSession(keyOwner?.id ?? key.user_id);
    setSessionCookie(res, sessionToken);
    sendJson(res, 200, { ok: true, name: key.name });
    return;
  }

  // ── Magic link auth routes ──────────────────────────────────────
  if (url.pathname === "/auth/magic-link" && req.method === "POST") {
    let body: string;
    try { body = await readBody(req); } catch { sendJson(res, 400, { error: "read error" }); return; }
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { sendJson(res, 400, { error: "invalid json" }); return; }
    const email = parsed.email;
    const redirect = parsed.redirect;
    if (!email || typeof email !== "string") { sendJson(res, 400, { error: "email required" }); return; }
    try {
      await requestMagicLink(email, GROVE_URL, redirect);
    } catch (err) {
      console.error("[auth] magic link error:", err);
    }
    // Always return success to prevent email enumeration
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/auth/verify" && req.method === "GET") {
    const token = url.searchParams.get("token") ?? "";
    const email = url.searchParams.get("email") ?? "";
    const redirect = url.searchParams.get("redirect") ?? "";
    if (!token || !email) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<!DOCTYPE html><html><body><p>Invalid link.</p></body></html>");
      return;
    }
    const csrf = generateCsrfToken();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(verifyPage(token, email, csrf, redirect));
    return;
  }

  if (url.pathname === "/auth/verify" && req.method === "POST") {
    let body: string;
    try { body = await readBody(req); } catch { sendJson(res, 400, { error: "read error" }); return; }
    const params = new URLSearchParams(body);
    const token = params.get("token") ?? "";
    const email = params.get("email") ?? "";
    const csrf = params.get("csrf") ?? "";
    const redirect = params.get("redirect") ?? "";

    if (!validateCsrfToken(csrf)) {
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!DOCTYPE html><html><body><p>Invalid or expired request. <a href=\"/\">Try again</a></p></body></html>");
      return;
    }

    const result = verifyMagicLink(token, email);
    if (!result) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!DOCTYPE html><html><body><p>This link is invalid or has expired. <a href=\"/\">Request a new one</a></p></body></html>");
      return;
    }

    // If redirect to grove.md, use auth code flow
    if (redirect && redirect.startsWith("https://grove.md")) {
      const code = createAuthCode(result.user.id);
      res.writeHead(302, { "Location": `${redirect}?code=${code}` });
      res.end();
      return;
    }

    setSessionCookie(res, result.sessionToken);
    res.writeHead(302, { "Location": "/" });
    res.end();
    return;
  }

  if (url.pathname === "/auth/exchange" && req.method === "GET") {
    const code = url.searchParams.get("code") ?? "";
    if (!code) { sendJson(res, 400, { error: "code required" }); return; }
    const result = exchangeAuthCode(code);
    if (!result) { sendJson(res, 401, { error: "invalid or expired code" }); return; }
    // Set session cookie so the caller can make authenticated requests (e.g. create keys)
    setSessionCookie(res, result.sessionToken);
    sendJson(res, 200, { session_token: result.sessionToken, user: result.user });
    return;
  }

  if (url.pathname === "/auth/session" && req.method === "GET") {
    const sessionToken = getSessionFromCookie(req);
    res.setHeader("Access-Control-Allow-Origin", GROVE_URL);
    if (!sessionToken) { sendJson(res, 401, { error: "not authenticated" }); return; }
    const user = validateSession(sessionToken);
    if (!user) { sendJson(res, 401, { error: "session expired" }); return; }
    sendJson(res, 200, { user: { id: user.id, username: user.username, email: user.email } });
    return;
  }

  if (url.pathname === "/auth/logout" && req.method === "POST") {
    const sessionToken = getSessionFromCookie(req);
    if (sessionToken) destroySession(sessionToken);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── Setup page at / ──
  if (url.pathname === "/" && req.method === "GET") {
    const admin = adminAuth(req);
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const authed = admin ?? (token ? (() => { const k = validateToken(token); return k ? { keyId: k.id, keyName: k.name } : null; })() : null);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(setupPage(authed?.keyName ?? null));
    return;
  }

  // ── Key management API (admin session cookie or bearer auth required) ──
  if (url.pathname === "/keys" && req.method === "POST") {
    const admin = adminAuth(req);
    if (!admin) { sendJson(res, 401, { error: "unauthorized" }); return; }

    let body: string;
    try { body = await readBody(req); } catch (err: unknown) {
      if ((err as Error).message === "payload too large") { sendJson(res, 413, { error: "payload too large" }); return; }
      sendJson(res, 400, { error: "read error" }); return;
    }
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { sendJson(res, 400, { error: "invalid json" }); return; }

    if (parsed.action === "list") {
      const db = getDb();
      const allKeys = (db.prepare("SELECT id, name, scopes, vault_id, created_at, last_used_at, expires_at FROM api_keys").all() as StoredKey[]).map((k) => ({
        id: k.id,
        name: k.name,
        scopes: k.scopes,
        vault_id: k.vault_id,
        created_at: k.created_at,
        last_used_at: k.last_used_at,
        expires_at: k.expires_at,
      }));
      sendJson(res, 200, { keys: allKeys });
      return;
    }
    if (parsed.action === "create" && parsed.name) {
      const result = createKey(parsed.name, parsed.scopes ?? ["read", "write"], parsed.vault ?? "life");
      sendJson(res, 200, { id: result.id, name: result.name, token: result.token });
      return;
    }
    if (parsed.action === "revoke" && parsed.id) {
      revokeKey(parsed.id);
      sendJson(res, 200, { revoked: parsed.id });
      return;
    }
    sendJson(res, 400, { error: "invalid action" });
    return;
  }

  // Search endpoint — proxies to the BM25 search server on 8177
  if (url.pathname.startsWith("/search")) {
    const authHeader2 = req.headers.authorization;
    const token2 = authHeader2?.startsWith("Bearer ") ? authHeader2.slice(7) : null;
    if (!token2 || !validateToken(token2)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const searchHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === "authorization" || k === "host") continue;
      if (v) searchHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    const searchReq = httpRequest(
      { hostname: "127.0.0.1", port: 8177, path: req.url, method: req.method, headers: searchHeaders },
      (searchRes) => {
        const h: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(searchRes.headers)) { if (v) h[k] = v; }
        h["access-control-allow-origin"] = "*";
        res.writeHead(searchRes.statusCode ?? 200, h);
        searchRes.pipe(res);
      }
    );
    searchReq.on("error", () => {
      if (!res.headersSent) sendJson(res, 502, { error: "Search server unreachable" });
    });
    req.pipe(searchReq);
    return;
  }

  // ── REST API v1 endpoints (for grove-www note viewer) ──────────────
  // These are GET-only, Bearer-authed, CORS-locked to grove.md.
  if (url.pathname.startsWith("/v1/")) {
    const REST_CORS_ORIGIN = process.env.GROVE_WWW_ORIGIN ?? "https://grove.md";

    // CORS for /v1/* — locked to grove.md only
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": REST_CORS_ORIGIN,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    // Auth — Bearer token required
    const restAuth = req.headers.authorization;
    const restToken = restAuth?.startsWith("Bearer ") ? restAuth.slice(7) : null;
    if (!restToken) {
      res.writeHead(401, { "Content-Type": "application/json", "Access-Control-Allow-Origin": REST_CORS_ORIGIN });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const restKey = validateToken(restToken);
    if (!restKey) {
      res.writeHead(401, { "Content-Type": "application/json", "Access-Control-Allow-Origin": REST_CORS_ORIGIN });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // Rate limit (REST bucket, higher limits for owner)
    const restRateResult = rateLimiter.check(restKey.id, "read");
    if (!restRateResult.allowed) {
      res.writeHead(429, { "Content-Type": "application/json", "Access-Control-Allow-Origin": REST_CORS_ORIGIN });
      res.end(JSON.stringify({ error: "rate_limited", retry_after_ms: restRateResult.retryAfterMs }));
      return;
    }
    rateLimiter.record(restKey.id, "read");

    const restHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": REST_CORS_ORIGIN };

    // Resolve trail for this key (null = owner, full access)
    const restTrail = resolveTrail(restKey.id);

    // GET /v1/notes/* — fetch a single note with resolved links and backlinks
    if (url.pathname.startsWith("/v1/notes/") && req.method === "GET") {
      const notePath = decodeURIComponent(url.pathname.slice("/v1/notes/".length));
      if (!notePath || notePath.includes("..")) {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "invalid path" }));
        return;
      }

      structuredLog("info", "rest.get_note", rid, { key_id: restKey.id, key_name: restKey.name, path: notePath });
      try {
        const note = await handleGetNote(notePath, restTrail);
        if (!note) {
          res.writeHead(404, restHeaders);
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        res.writeHead(200, { ...restHeaders, "ETag": `"${note.content_hash}"` });
        res.end(JSON.stringify(note));
      } catch (err) {
        console.error("[rest] get_note error:", err);
        res.writeHead(500, restHeaders);
        res.end(JSON.stringify({ error: "internal error" }));
      }
      return;
    }

    // GET /v1/search?q=...&limit=N — hybrid search
    if (url.pathname === "/v1/search" && req.method === "GET") {
      const query = url.searchParams.get("q") ?? "";
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), 50);
      if (!query) {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "missing q parameter" }));
        return;
      }

      structuredLog("info", "rest.search", rid, { key_id: restKey.id, key_name: restKey.name, query, limit });
      try {
        const results = await handleSearch(query, limit, restTrail);
        res.writeHead(200, restHeaders);
        res.end(JSON.stringify({ results }));
      } catch (err) {
        console.error("[rest] search error:", err);
        res.writeHead(500, restHeaders);
        res.end(JSON.stringify({ error: "internal error" }));
      }
      return;
    }

    // GET /v1/list?prefix=... — list notes under a path prefix
    if (url.pathname === "/v1/list" && req.method === "GET") {
      const prefix = url.searchParams.get("prefix") ?? "";
      if (prefix.includes("..")) {
        res.writeHead(400, restHeaders);
        res.end(JSON.stringify({ error: "invalid prefix" }));
        return;
      }

      structuredLog("info", "rest.list", rid, { key_id: restKey.id, key_name: restKey.name, prefix });
      try {
        const entries = handleListNotes(prefix, restTrail);
        res.writeHead(200, restHeaders);
        res.end(JSON.stringify({ prefix, entries }));
      } catch (err) {
        console.error("[rest] list error:", err);
        res.writeHead(500, restHeaders);
        res.end(JSON.stringify({ error: "internal error" }));
      }
      return;
    }

    // GET /v1/stats?sections=vault,graph — vault analytics
    if (url.pathname === "/v1/stats" && req.method === "GET") {
      const sectionsParam = url.searchParams.get("sections");
      const sections = sectionsParam ? sectionsParam.split(",").map(s => s.trim()) : undefined;

      // Admin check: owner keys (no trail) get search stats
      const isAdmin = !restTrail;

      structuredLog("info", "rest.stats", rid, { key_id: restKey.id, key_name: restKey.name, sections: sections?.join(",") });

      const stats = handleStats(sections, restTrail, isAdmin);
      if (!stats) {
        res.writeHead(503, restHeaders);
        res.end(JSON.stringify({ error: "stats not yet computed, try again shortly" }));
        return;
      }
      res.writeHead(200, restHeaders);
      res.end(JSON.stringify(stats));
      return;
    }

    // Unknown /v1/ route
    res.writeHead(404, restHeaders);
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  // Auth check for MCP and other endpoints
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    structuredLog("warn", "auth.missing", rid, { method: req.method, path: req.url, status: 401 });
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${GROVE_URL}/.well-known/oauth-protected-resource"`,
    });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const key = validateToken(token);
  if (!key) {
    structuredLog("warn", "auth.invalid", rid, { method: req.method, path: req.url, status: 401 });
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${GROVE_URL}/.well-known/oauth-protected-resource"`,
    });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const reqStart = Date.now();
  const sessionId = req.headers["mcp-session-id"];
  const sessionStr = Array.isArray(sessionId) ? sessionId[0] : sessionId;

  // Trail resolution — look up if this key is associated with a trail
  const trail = resolveTrail(key.id);

  // Forward ALL MCP requests to the Grove server (which owns all 6 tools)
  if (url.pathname === "/mcp") {
    let body = "";
    if (req.method === "POST") {
      try { body = await readBody(req); } catch (err: unknown) {
        if ((err as Error).message === "payload too large") { sendJson(res, 413, { error: "payload too large" }); return; }
        sendJson(res, 400, { error: "read error" }); return;
      }
    }
    let parsed: any = null;
    if (body) try { parsed = JSON.parse(body); } catch {
      // Non-JSON body is fine — we only parse for logging metadata extraction
    }

    const mcpMethod = parsed?.method ?? req.method;
    const toolName = parsed?.params?.name ?? null;
    structuredLog("info", "mcp.request", rid, { key_id: key.id, key_name: key.name, method: req.method, path: "/mcp", mcp_method: mcpMethod, tool: toolName });

    // Per-trail rate limits
    if (trail) {
      const isTrailWrite = mcpMethod === "tools/call" && toolName === "write_note";
      const trailLimit = isTrailWrite
        ? (trail.rate_limit_writes ?? 20)
        : (trail.rate_limit_reads ?? 60);
      const trailRateResult = rateLimiter.checkWithLimit(
        `trail:${trail.id}`,
        isTrailWrite ? "write" : "read",
        trailLimit,
      );
      if (!trailRateResult.allowed) {
        structuredLog("warn", "trail.rate_limited", rid, { trail_id: trail.id, trail_name: trail.name, type: isTrailWrite ? "write" : "read" });
        sendJson(res, 429, { error: "trail rate limit exceeded", retry_after_ms: trailRateResult.retryAfterMs });
        return;
      }
      rateLimiter.record(`trail:${trail.id}`, isTrailWrite ? "write" : "read");
    }

    // Audit read/write tool calls
    if (mcpMethod === "tools/call" && toolName) {
      const toolArgs = parsed?.params?.arguments;
      if (toolName === "write_note") {
        auditWrite(rid, key.id, key.name, toolName, toolArgs, null);
      } else {
        auditRead(rid, key.id, key.name, toolName, toolArgs);
      }
    }

    // Scope enforcement — reject write tools if key lacks 'write' scope
    if (mcpMethod === "tools/call" && toolName === "write_note") {
      const keyScopes = key.scopes.split(",");
      if (!keyScopes.includes("write")) {
        structuredLog("warn", "auth.scope_denied", rid, { key_id: key.id, key_name: key.name, tool: toolName });
        sendJson(res, 403, { error: "scope_denied", detail: "key lacks 'write' scope" });
        return;
      }
    }

    // Rate limit tool calls
    if (mcpMethod === "tools/call" && toolName) {
      const isWrite = toolName === "write_note";
      const { allowed, retryAfterMs } = rateLimiter.check(key.id, isWrite ? "write" : "read");
      if (!allowed) {
        sendJson(res, 429, { error: "rate_limited", retry_after_ms: retryAfterMs });
        return;
      }
      rateLimiter.record(key.id, isWrite ? "write" : "read");
    }

    // Build headers for Grove server (strip auth, add Accept, pass correlation ID + trail info, optionally strip stale session)
    function groveHeaders(stripSession = false): Record<string, string> {
      const h: Record<string, string> = { "Accept": "application/json, text/event-stream", "X-Request-Id": rid };
      if (trail) {
        h["X-Trail-Id"] = trail.id;
        h["X-Trail-Config"] = JSON.stringify({
          id: trail.id,
          name: trail.name,
          allow_tags: trail.allow_tags,
          deny_tags: trail.deny_tags,
          allow_types: trail.allow_types,
          deny_types: trail.deny_types,
          allow_paths: trail.allow_paths,
          deny_paths: trail.deny_paths,
          rate_limit_writes: trail.rate_limit_writes,
        });
      }
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === "authorization" || k === "host") continue;
        if (stripSession && k === "mcp-session-id") continue;
        if (v) h[k] = Array.isArray(v) ? v.join(", ") : v;
      }
      return h;
    }

    // Proxy to Grove server, piping response headers and body through
    // If Grove returns 400 (invalid/stale session), retry without session ID to create a new one
    const groveReq = httpRequest(
      { hostname: "127.0.0.1", port: GROVE_SERVER_PORT, path: "/mcp", method: req.method, headers: groveHeaders() },
      (groveRes) => {
        // If stale session → initialize a new session, then replay the request
        if (groveRes.statusCode === 400 && sessionStr && req.method === "POST") {
          groveRes.resume();
          console.log("[proxy] stale session, initializing new Grove session");

          // Step 1: send initialize to get a new session
          const initBody = JSON.stringify({
            jsonrpc: "2.0", id: "proxy-init",
            method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "grove-proxy", version: "1" } },
          });
          const initReq = httpRequest(
            { hostname: "127.0.0.1", port: GROVE_SERVER_PORT, path: "/mcp", method: "POST",
              headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Content-Length": String(Buffer.byteLength(initBody)) } },
            (initRes) => {
              let initData = "";
              const newSession = initRes.headers["mcp-session-id"] as string | undefined;
              initRes.on("data", (c) => initData += c);
              initRes.on("end", () => {
                if (!newSession) {
                  console.error("[proxy] failed to get new session from Grove");
                  pipeGroveResponse(groveRes); // fall back to original error
                  return;
                }
                console.log("[proxy] new session:", newSession);
                // Step 2: replay original request with new session
                const replayHeaders = groveHeaders(true);
                replayHeaders["mcp-session-id"] = newSession;
                const retryReq = httpRequest(
                  { hostname: "127.0.0.1", port: GROVE_SERVER_PORT, path: "/mcp", method: "POST", headers: replayHeaders },
                  (retryRes) => pipeGroveResponse(retryRes),
                );
                retryReq.on("error", () => { if (!res.headersSent) sendJson(res, 502, { error: "Grove server unreachable" }); });
                if (body) retryReq.write(body);
                retryReq.end();
              });
            },
          );
          initReq.on("error", () => { if (!res.headersSent) sendJson(res, 502, { error: "Grove init failed" }); });
          initReq.write(initBody);
          initReq.end();
          return;
        }
        pipeGroveResponse(groveRes);
      }
    );

    function pipeGroveResponse(groveRes: import("node:http").IncomingMessage) {
      const resHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(groveRes.headers)) { if (v) resHeaders[k] = v; }
      resHeaders["access-control-allow-origin"] = "*";
      resHeaders["access-control-allow-methods"] = "GET, POST, DELETE, OPTIONS";
      resHeaders["access-control-allow-headers"] = "Content-Type, Authorization, mcp-session-id";
      resHeaders["access-control-expose-headers"] = "mcp-session-id";
      res.writeHead(groveRes.statusCode ?? 200, resHeaders);

      if (parsed?.method === "tools/call" && toolName) {
        let resBody = "";
        groveRes.on("data", (c) => { resBody += c; res.write(c); });
        groveRes.on("end", () => {
          res.end();
          const latency = Date.now() - reqStart;
          try {
            logMcp(key.name, sessionStr, toolName, parsed.params.arguments, JSON.parse(resBody), latency, groveRes.statusCode ?? 200);
          } catch {
            // Response isn't valid JSON — log raw length instead for diagnostics
            logMcp(key.name, sessionStr, toolName, parsed.params.arguments, { raw_length: resBody.length }, latency, groveRes.statusCode ?? 200);
          }
        });
      } else {
        groveRes.pipe(res);
        if (mcpMethod !== "unknown") {
          groveRes.on("end", () => {
            log(key.name, req.method ?? "", "/mcp", groveRes.statusCode ?? 200, { mcp_method: mcpMethod, latency_ms: Date.now() - reqStart });
          });
        }
      }
    }

    groveReq.on("error", (err) => {
      console.error("[proxy] Grove server error:", err.message);
      if (!res.headersSent) sendJson(res, 502, { error: "Grove server unreachable" });
    });
    if (body) groveReq.write(body);
    groveReq.end();
    return;
  }

  structuredLog("info", "proxy.qmd", rid, { key_id: key.id, key_name: key.name, method: req.method, path: req.url, status: 200 });
  proxyToQmd(req, res);
});

runMigration();
seedAdminEmail();
cleanupExpiredAuth();

const VAULT_PATH_PROXY = process.env.GROVE_VAULT ?? join(homedir(), "life");
startStatsTimer(VAULT_PATH_PROXY);

const keyCount = getDb().prepare("SELECT COUNT(*) as count FROM api_keys").get() as { count: number };

server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log(`Grove proxy listening on http://0.0.0.0:${PROXY_PORT}`);
  console.log(`Proxying authenticated requests to QMD at http://[::1]:${QMD_PORT}`);
  console.log(`OAuth authorize: ${GROVE_URL}/oauth/authorize`);
  console.log(`Loaded ${keyCount.count} API key(s) from SQLite`);
});
