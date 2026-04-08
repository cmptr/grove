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
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { RateLimiter } from "./rate-limit.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadKeys, createKey, revokeKey, type StoredKey } from "./keys.js";

const QMD_PORT = Number(process.env.QMD_PORT ?? 8181);
const GROVE_SERVER_PORT = Number(process.env.GROVE_SERVER_PORT ?? 8190);
const PROXY_PORT = Number(process.env.GROVE_PORT ?? 8420);
const LOG_DIR = join(homedir(), ".grove");
const LOG_PATH = join(LOG_DIR, "proxy.log");
const MCP_LOG_PATH = join(LOG_DIR, "mcp.jsonl");
const GROVE_URL = process.env.GROVE_URL ?? "https://grove.mili.dev";

let keys: StoredKey[] = [];
const rateLimiter = new RateLimiter({ reads: 120, writes: 20, windowMs: 60_000 });

function reloadKeys() {
  keys = loadKeys();
}

function validateToken(token: string): StoredKey | null {
  const hash = createHash("sha256").update(token).digest("hex");
  return keys.find((k) => k.hashed_token === hash) ?? null;
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

interface OAuthClient {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  registered_at: string;
}

interface AuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  api_key: string; // the grove API key the user entered
  expires_at: number;
  code_challenge?: string;
  code_challenge_method?: string;
}

const CLIENTS_PATH = join(homedir(), ".grove", "oauth-clients.json");
const CODES_PATH = join(homedir(), ".grove", "oauth-codes.json");

function loadJson<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch {
    // File missing or corrupt JSON — start fresh with empty array
    return [];
  }
}

function saveJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function handleOAuth(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const path = url.pathname;

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
      const client: OAuthClient = {
        client_id: "grove_client_" + randomBytes(16).toString("hex"),
        client_secret: "grove_secret_" + randomBytes(32).toString("hex"),
        redirect_uris: data.redirect_uris || [],
        registered_at: new Date().toISOString(),
      };
      const clients = loadJson<OAuthClient>(CLIENTS_PATH);
      clients.push(client);
      saveJson(CLIENTS_PATH, clients);
      console.log(`OAuth client registered: ${client.client_id}`);
      sendJson(res, 201, {
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uris: client.redirect_uris,
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
<html><head><title>Grove — Authorize</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 420px; margin: 60px auto; padding: 0 20px; background: #0a0a0a; color: #e0e0e0; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  p { color: #888; font-size: 14px; line-height: 1.5; }
  input[type=password] { width: 100%; padding: 12px; font-size: 14px; font-family: monospace; border: 1px solid #333; border-radius: 8px; background: #1a1a1a; color: #e0e0e0; box-sizing: border-box; margin: 8px 0; }
  button { width: 100%; padding: 12px; font-size: 16px; background: #2d5a27; color: white; border: none; border-radius: 8px; cursor: pointer; margin-top: 8px; }
  button:hover { background: #3a7233; }
  .grove { color: #4a9; }
</style></head>
<body>
  <h1><span class="grove">Grove</span> — Authorize</h1>
  <p>Paste your Grove API key to connect Claude to your vault.</p>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${clientId}">
    <input type="hidden" name="redirect_uri" value="${redirectUri}">
    <input type="hidden" name="state" value="${state}">
    <input type="hidden" name="code_challenge" value="${codeChallenge}">
    <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">
    <input type="password" name="api_key" placeholder="grove_live_..." required autofocus>
    <button type="submit">Connect</button>
  </form>
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

      // Generate auth code
      const code: AuthCode = {
        code: randomBytes(32).toString("hex"),
        client_id: clientId,
        redirect_uri: redirectUri,
        api_key: apiKey,
        expires_at: Date.now() + 5 * 60 * 1000, // 5 min
      };

      // Store code_challenge for PKCE
      code.code_challenge = codeChallenge;
      code.code_challenge_method = codeChallengeMethod;

      const codes = loadJson<AuthCode>(CODES_PATH);
      codes.push(code);
      saveJson(CODES_PATH, codes);

      console.log(`OAuth code issued for key: ${key.name}`);

      // Redirect back to Claude
      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", code.code);
      if (state) redirect.searchParams.set("state", state);
      res.writeHead(302, { Location: redirect.toString() });
      res.end();
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

      const codes = loadJson<AuthCode>(CODES_PATH);
      const idx = codes.findIndex((c) => c.code === code);
      if (idx === -1) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "Code not found" });
        return;
      }

      const authCode = codes[idx];

      // Check expiry
      if (Date.now() > authCode.expires_at) {
        codes.splice(idx, 1);
        saveJson(CODES_PATH, codes);
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

      // Remove used code
      codes.splice(idx, 1);
      saveJson(CODES_PATH, codes);

      console.log(`OAuth token issued for code`);

      // Return the original API key as the access token
      sendJson(res, 200, {
        access_token: authCode.api_key,
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
    <h2>Authenticate</h2>
    <input type="password" id="token-input" placeholder="Paste your API key (grove_live_...)" />
    <button onclick="auth()">Sign in</button>
    <p class="note">Need a key? Create one via SSH: <code>cd ~/grove && npx tsx src/keys.ts create --name my-key</code></p>
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
function auth() {
  bearerToken = document.getElementById('token-input').value.trim();
  if (!bearerToken) return;
  fetch('/health', { headers: { 'Authorization': 'Bearer ' + bearerToken } })
    .then(() => {
      document.getElementById('auth-section').style.display = 'none';
      document.getElementById('authed').style.display = 'block';
      loadKeys();
    });
}
function loadKeys() {
  // We can't list keys via API yet — just show a placeholder
  document.getElementById('key-list').innerHTML = '<p class="note">Key management available via CLI: <code>npx tsx src/keys.ts list</code></p>';
}
function createKey() {
  const name = document.getElementById('key-name').value.trim();
  if (!name) return;
  fetch('/keys', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + bearerToken, 'Content-Type': 'application/json' },
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
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

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
      "Access-Control-Expose-Headers": "mcp-session-id",
    });
    res.end();
    return;
  }

  // OAuth endpoints (unauthenticated)
  if (handleOAuth(req, res, url)) return;

  // Health check — unauthenticated
  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true, proxy: true });
    return;
  }

  // ── Setup page at / ──
  if (url.pathname === "/" && req.method === "GET") {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const authed = token ? validateToken(token) : null;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(setupPage(authed?.name ?? null));
    return;
  }

  // ── Key management API (bearer auth required) ──
  if (url.pathname === "/keys" && req.method === "POST") {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const authed = token ? validateToken(token) : null;
    if (!authed) { sendJson(res, 401, { error: "unauthorized" }); return; }

    const body = await readBody(req);
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { sendJson(res, 400, { error: "invalid json" }); return; }

    if (parsed.action === "create" && parsed.name) {
      const result = createKey(parsed.name, parsed.scopes ?? ["read", "write"], parsed.vault ?? "life");
      reloadKeys();
      sendJson(res, 200, { id: result.id, name: result.name, token: result.token });
      return;
    }
    if (parsed.action === "revoke" && parsed.id) {
      revokeKey(parsed.id);
      reloadKeys();
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

  // Auth check for MCP and other endpoints
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    log(null, req.method ?? "", req.url ?? "", 401);
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  const key = validateToken(token);
  if (!key) {
    log(null, req.method ?? "", req.url ?? "", 401);
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  const reqStart = Date.now();
  const sessionId = req.headers["mcp-session-id"];
  const sessionStr = Array.isArray(sessionId) ? sessionId[0] : sessionId;

  // Forward ALL MCP requests to the Grove server (which owns all 6 tools)
  if (url.pathname === "/mcp") {
    const body = req.method === "POST" ? await readBody(req) : "";
    let parsed: any = null;
    if (body) try { parsed = JSON.parse(body); } catch {
      // Non-JSON body is fine — we only parse for logging metadata extraction
    }

    const mcpMethod = parsed?.method ?? req.method;
    const toolName = parsed?.params?.name ?? null;
    log(key.name, req.method ?? "", "/mcp", 0, { mcp_method: mcpMethod, tool: toolName });

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

    // Build headers for Grove server (strip auth, add Accept, optionally strip stale session)
    function groveHeaders(stripSession = false): Record<string, string> {
      const h: Record<string, string> = { "Accept": "application/json, text/event-stream" };
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

  log(key.name, req.method ?? "", req.url ?? "", 200);
  proxyToQmd(req, res);
});

reloadKeys();
setInterval(reloadKeys, 30_000);

server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log(`Grove proxy listening on http://0.0.0.0:${PROXY_PORT}`);
  console.log(`Proxying authenticated requests to QMD at http://[::1]:${QMD_PORT}`);
  console.log(`OAuth authorize: ${GROVE_URL}/oauth/authorize`);
  console.log(`Loaded ${keys.length} API key(s)`);

  // Warm up TEI so first real query isn't slow
  const warmup = JSON.stringify({ input: "warmup" });
  const wreq = httpRequest(
    { hostname: "127.0.0.1", port: 8090, path: "/v1/embeddings", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(warmup) } },
    (wres) => { wres.resume(); wres.on("end", () => console.log("TEI warmed up")); }
  );
  wreq.on("error", () => console.log("TEI warmup failed (may not be running yet)"));
  wreq.write(warmup);
  wreq.end();
});
