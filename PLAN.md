# Grove — Implementation Plan

> A hosted knowledge API that makes Obsidian vaults searchable and writable from any Claude surface.

This document is the authoritative implementation spec for Grove. Agents working on this project should read this file first, follow it precisely, and update it as decisions are made or tasks are completed.

## Overview

Grove is a TypeScript API server that wraps a git-tracked Obsidian vault and exposes it as MCP tools. Any Claude surface (app, phone, web, Code) connects to Grove and gets structured access to the vault — search, read, write, with proper auth, sync, and concurrency.

**Stack:** TypeScript, Node.js (>=22), raw `node:http`, SQLite (via QMD), git
**Repo:** `~/src/grove`
**Vault:** `~/life/` (primary), `~/canva/` (deferred — Phase 8)
**Depends on:** `@tobilu/qmd` (search engine), `@modelcontextprotocol/sdk` (MCP transport)
**Deploys to:** AWS t3.medium at `api.grove.md` (52.37.76.231), frontend on Vercel at `grove.md`
**Live:** Phases 0-5 complete, security hardened, observable, magic link auth, persistent sessions, S3 backups, cross-domain auth with grove.md
**Next:** Ops dashboard (P4-4–P4-9) → Multi-user collaboration (Phase 9) → Knowledge views (P4-10+) → Discovery (Phase 7)

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Claude (any surface)                  │
│              phone · web · desktop · Code                │
└──────────────────────┬──────────────────────────────────┘
                       │ MCP (Streamable HTTP) or CLI
                       ▼
┌─────────────────────────────────────────────────────────┐
│                     Grove Server                         │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │   Auth    │  │  Router   │  │  Logger  │              │
│  │Middleware │→ │ /v1/...   │→ │  Audit   │              │
│  └──────────┘  └────┬──────┘  └──────────┘              │
│                     │                                    │
│       ┌─────────────┼─────────────┐                     │
│       ▼             ▼             ▼                      │
│  ┌─────────┐  ┌──────────┐  ┌─────────┐                │
│  │  Notes   │  │  Search  │  │  Vault  │                │
│  │ Service  │  │ Service  │  │ Service │                │
│  │          │  │  (QMD)   │  │  (git)  │                │
│  └────┬─────┘  └────┬─────┘  └────┬────┘                │
│       │             │              │                     │
│       ▼             ▼              ▼                     │
│  ┌──────────────────────────────────────┐               │
│  │         Write Queue (mutex)          │               │
│  │   All mutations serialized here      │               │
│  └──────────────┬───────────────────────┘               │
│                 ▼                                        │
│  ┌──────────────────────────────────────┐               │
│  │     Vault Filesystem (git repo)      │               │
│  │     + QMD SQLite Index               │               │
│  └──────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────┘
```

### Key architectural rules

1. **The vault (markdown files in git) is the sole source of truth.** The QMD index is a derived view. If they diverge, the index is wrong.
2. **All writes are serialized** through a single-threaded write queue. No concurrent git operations. Ever.
3. **The server is the sole writer to git.** Local machine pulls from git. One direction. No split brain.
4. **Every write creates a git commit** with the API key identity in the commit message.
5. **The search index updates synchronously on write** before returning 200. Eventual consistency is not acceptable — agents with no memory between calls will create duplicates.
6. **Notes are the domain model.** The API returns structured JSON (parsed frontmatter, resolved links, computed backlinks), not raw markdown.

---

## Phases

### Phase 0: Deploy and Validate ✅ COMPLETE 2026-04-01

**Goal:** Get the vault accessible from Claude.ai with auth. Validate by using it for 2 weeks.

**What was built:**
- Auth proxy (`src/proxy.ts`) on port 8420 — OAuth 2.0 + bearer tokens, proxies to QMD MCP (8181)
- Hybrid search (`src/hybrid-search.ts`) — BM25 + vector (TEI + sqlite-vec) + RRF fusion
- Key management (`src/keys.ts`) — create/list/revoke, SHA-256 hashed storage in `~/.grove/keys.json`
- Embedding pipeline (`src/embed-node.ts`) — Node.js script, embeds docs via TEI over SSH tunnel, stores in vec0
- Deployed on Vultr VPS at `api.grove.md` with nginx + Let's Encrypt TLS
- QMD MCP server + search server managed via PM2
- TEI (Text Embeddings Inference) running via Docker for query-time embedding
- Vault syncs every 5 min via cron

**What works:**
- MCP `get` tool — read any note ✅
- MCP `multi_get` tool — batch read ✅
- MCP `status` tool — index health ✅
- MCP `query` tool — hybrid search (BM25 + vector + RRF), falls back to BM25-only if TEI down ✅
- `/search?q=...&n=N` — BM25 keyword search (~3ms) ✅
- Auth — OAuth 2.0 (PKCE) for Claude.ai + bearer tokens ✅
- TLS — HTTPS via nginx + Let's Encrypt ✅
- 5636 chunk embeddings across 1028 docs (bge-base-en-v1.5, 768-dim) ✅

**What doesn't work yet:**
- No write operations (MCP tools are read-only; writes need Phase 1 write queue + git integration)
- No automatic re-embedding when vault changes (manual: run embed-node.ts, scp, restart)

**Infrastructure:**
- VPS: Vultr, 4 vCPU, 8GB RAM, Ubuntu 24.04, Node 22
- Domain: `api.grove.md` (DNS-only in Cloudflare, nginx handles TLS)
- PM2 processes: `grove-proxy` (8420), `qmd-mcp` (8181), `qmd-server` (8177)
- TEI Docker: `tei-embeddings` on port 8090 (BAAI/bge-base-en-v1.5, `--auto-truncate`)
- API key: `key_a3802af4` (claude-ai, read+write, life vault)

**Tasks:**

- [x] **P0-1: Auth proxy** — `src/proxy.ts`, bearer tokens + OAuth 2.0 (PKCE) for Claude.ai
- [x] **P0-2: Key management** — `src/keys.ts`, create/list/revoke CLI
- [x] **P0-3: Deploy to VPS** — nginx + Let's Encrypt on `api.grove.md`
- [x] **P0-4: Register as Claude.ai custom connector** — connected via OAuth, working from all surfaces
- [x] **P0-5a: Hybrid search** — BM25 + vector + RRF fusion via TEI + sqlite-vec (replaced OpenAI API plan with self-hosted TEI for privacy)
- [ ] **P0-5b: Usage journal** — use for 2 weeks, note what's missing

**Key decisions made during Phase 0:**
- **Embeddings: self-hosted TEI** (not OpenAI API) — privacy-first, same bge-base-en-v1.5 model on Mac and VPS
- **Embed on Mac, sync to VPS** — vec0 bulk ops OOM on VPS; Mac embeds via Node.js (not Python — Python 3.14 + vec0 has catastrophic GC issues), scp index to VPS
- **OAuth 2.0 required** — Claude.ai custom connectors only support OAuth, not plain bearer tokens; proxy implements full OAuth flow with PKCE
- **VPS upgraded to 8GB** — 2GB was too small for TEI + QMD + proxy; 8GB/4CPU handles everything comfortably

### Phase 1: Close the Garden Loop

**Goal:** Two-way data flow. Conversations on any Claude surface read from AND write back to the vault. Garden operations (plant, harvest, tend) work from Claude.ai.

**Key insight:** Garden operations split into two categories:
- **Query-scoped** (plant, seek, basic harvest): compose from search + read + write primitives. Claude orchestrates.
- **Vault-scoped** (tend, wander, digest): require whole-graph knowledge. Need server-side computation.

**Architecture:** Build a proper Grove MCP server (not more proxy interceptors). Proxy stays for auth/OAuth/CORS, forwards to Grove server. QMD becomes a search backend.

**Duration:** Weekend-scale project (~560 lines new code)

#### The 6 MCP Tools

| # | Tool | What it does | Garden operations |
|---|------|-------------|-------------------|
| 1 | `query` | Hybrid search (BM25 + vector + RRF) | **seek** |
| 2 | `get` | Read note with fuzzy path resolution | **seek**, **harvest**, **wander** |
| 3 | `multi_get` | Batch read by glob or list | **harvest** (batch entities), **tend** |
| 4 | `write_note` | Create/update with frontmatter validation, git commit, reindex | **plant**, **harvest** (wire links, create entities) |
| 5 | `list_notes` | Browse + metadata + entity index (names, types, aliases) | **tend** (scan), **harvest** (entity vocab), **plant** (dedup) |
| 6 | `vault_status` | Health + diagnostics + history + metrics | **tend** (orphans, broken links), **garden** (digest), **wander** (graph stats) |

#### Where primitives compose vs where the server must help

| Operation | Composition | Calls | Server help needed? |
|-----------|------------|-------|---------------------|
| **Plant** (create note) | query → list_notes → write_note | 2-3 | No |
| **Plant** (wire mentions) | query → get × N → write_note × N | 20-35 | No (interactive) |
| **Harvest** (basic) | get → list_notes(aliases) → write_note | 3-8 | `list_notes` returns aliases |
| **Tend** (diagnostics) | vault_status(diagnostics) | 1 | Yes — whole-graph scan |
| **Wander** (graph walk) | vault_status(graph) | 1 | Yes — Brandes centrality + BFS clusters ✅ |
| **Garden** (daily digest) | vault_status(digest) + vault_status(history) | 1-2 | Yes — git-based lifecycle classification ✅ |

#### Architecture

```
Claude.ai → proxy.ts (auth/OAuth/CORS/logging) → Grove MCP server (all 6 tools)
                                                        ↓
                                              hybrid-search.ts (search)
                                              vault filesystem (read/write)
                                              vault-ops.ts (git)
                                              QMD index (sqlite)
```

- **Proxy stays** for auth, OAuth, CORS, audit logging
- **New Grove MCP server** (`src/server.ts`) replaces QMD as MCP backend — registers all 6 tools via SDK
- **QMD becomes a search backend** — hybrid-search.ts calls QMD's HTTP endpoints internally

#### Phase 1a Tasks (Close the Loop)

- [x] **P1-1: Write queue** (`src/write-queue.ts`) — promise-chain mutex, 30s push timer, error isolation
- [x] **P1-2: Vault operations** (`src/vault-ops.ts`) — git commit/push/log, QMD reindex, file listing, startup recovery
- [x] **P1-3: Note validation** (`src/notes-validate.ts`) — type whitelist, required fields, path security, safe YAML
- [x] **P1-4: Grove MCP server** (`src/server.ts`) — 6 tools registered via SDK with Streamable HTTP transport
- [x] **P1-5: Wire proxy → Grove server** — proxy forwards /mcp to Grove (8190), keeps auth/OAuth/CORS/logging
- [x] **P1-6: VPS git setup** — vault as git repo, startup recovery, push/pull working
- [x] **P1-7: End-to-end test** — write_note creates file + git commit + QMD reindex, get reads it back, diagnostics work

#### Phase 1b Tasks (Polish)

- [x] **P1-8: vault_status graph mode** — Brandes centrality, BFS clusters, degree analysis (`vault-graph.ts`)
- [x] **P1-9: vault_status digest mode** — git-based lifecycle classification (`vault-graph.ts`)
- [x] **P1-10: Auto-embed on write** — fire-and-forget `embedFile()` after write_note (`embed-single.ts`)
- [x] **P1-11: Rate limiting** — 120 reads/60s, 20 writes/60s sliding window (`rate-limit.ts`)
- [x] **P1-12: Idempotency** — LRU cache, 1000 entries, 1hr TTL (`rate-limit.ts`)
- [x] **P1-13: Unit tests** — 37 tests across 3 files, all passing (`test/*.test.ts`)
- [x] **P1-14: CLI client** — `grove search/read/list/write/history/status/diagnostics` (`cli.ts`)
- [x] **P1-15: MCP Resources** — notes as `vault://life/{path}` resources (`server.ts`)

### Phase 2: Security Hardening

**Goal:** Close every exploitable gap before opening access to others. Path traversal and CORS are exploitable today.

**Prerequisites:** Phase 1 deployed and stable.

#### Phase 2a: Critical Fixes (ship immediately)

- [x] **P2-1: Path traversal guard** (`src/server.ts`)
  Resolve all file paths to absolute, reject anything outside vault root. No `..`, no symlinks escaping the vault. Test with `../../etc/passwd` and `../../.grove/keys.json`. This is exploitable today — top priority.

- [x] **P2-2: CORS lockdown** (`src/proxy.ts`, `src/server.ts`)
  Cookie-auth routes (`/auth/*`, `/admin/*`, `/keys`, `/`) locked to `GROVE_URL`. Bearer-only routes (`/mcp`, `/search`) keep `*` (required for MCP clients). `/v1/*` locked to `grove.md`.

- [x] **P2-3: Request body size limit** (`src/proxy.ts`)
  Hard cap at 1MB on `node:http` layer. Prevents memory/disk exhaustion from malicious or buggy clients.

- [x] **P2-4: Enforce key scopes** (`src/proxy.ts`)
  `write_note` tool calls check key scopes — read-only keys get 403 `scope_denied`. Logged via structured logger.

#### Phase 2b: Infrastructure Security

- [x] **P2-5: EBS encryption**
  Volume already encrypted (AES-256, AWS-managed CMK). Verified via `aws ec2 describe-volumes`.

- [x] **P2-6: Daily S3 backups**
  Cron job tars `~/.grove/` (keys, trails, configs) + QMD index and ships to S3 with server-side encryption. Vault itself is in git (GitHub private). QMD index and embeddings are derived and rebuildable, but backing up saves hours of re-embedding.

- [x] **P2-7: Move secrets out of plaintext JSON**
  OAuth clients and codes migrated from JSON to SQLite. Client secrets stored as SHA-256 hashes. API keys encrypted (AES-256-GCM) during OAuth code flow. JSON files renamed to `.migrated`.

- [x] **P2-8: Key TTLs and rotation**
  Add `expires_at` to key schema. CLI: `grove keys create foo --ttl 90d`. Expired keys fail auth. No forced rotation yet — TTLs are the first step.

#### Phase 2 Tests

- Path traversal: unit tests with `..`, symlinks, absolute paths outside vault
- CORS: integration test verifying non-allowed origins get rejected
- Scope enforcement: integration test — read-only key attempts write, gets 403
- Body size: send 2MB payload, verify 413 response

---

### Phase 3: Observability

**Goal:** Full visibility into system health, request patterns, and failures. Alert within 2 minutes of downtime.

**Prerequisites:** Phase 2a critical fixes deployed.

**Monitoring provider:** BetterStack (uptime + log ingestion + alerting, free tier covers this scale).

#### Phase 3a: Structured Logging

- [x] **P3-1: JSON structured logs** (`src/logger.ts`)
  One JSON line per request to stdout (PM2 captures). Format:
  ```json
  {"ts":"ISO8601","rid":"ulid","method":"POST","path":"/mcp","tool":"query","key_id":"abc123","status":200,"duration_ms":142,"error":null,"bytes_out":2847}
  ```
  Essential fields: timestamp, request ID (`rid`), tool name, key identity (not the raw token), status, duration, error. Add `vault_path` on writes.

- [x] **P3-2: Request correlation IDs**
  Generate ULID at proxy entry. Pass as `X-Request-Id` header to Grove server. Both layers log the same `rid`. Enables tracing a request through proxy → server → vault op.

- [x] **P3-3: Audit log for reads**
  Today writes are traced via git commits, but reads are invisible. Log every read with key identity for trail consumers. Store in `~/.grove/audit.jsonl`, rotate daily.

#### Phase 3b: Health & Metrics

- [x] **P3-4: Deep health check** (`/health`)
  Proxy health must verify downstream: QMD index accessible, embed server responding, vault git status clean. A proxy that says "I'm fine" while QMD is dead is worse than no health check.

- [x] **P3-5: `/metrics` endpoint** (JSON, not Prometheus)
  Internal counters (reset on restart, fine for dashboard). Persist daily rollups to SQLite for history.
  - `requests_total` by tool name and status code
  - `latency_p50`, `p95`, `p99` (1000-sample rolling reservoir)
  - `errors_total` by type (auth, upstream timeout, write queue, search)
  - `write_queue_depth` and `write_queue_wait_ms`
  - `search_latency_ms` (BM25 vs vector separately)
  - `embedding_latency_ms`
  - `uptime_seconds`

- [x] **P3-6: BetterStack integration**
  - Uptime monitor on `https://api.grove.md/health` (3-min checks, 2-min confirmation, email alerts)
  - Heartbeat ping every 5 min from vault-stats computation
  - Vector log shipper (systemd service) forwarding PM2 stdout/stderr to BetterStack Logs
  - grove.md uptime monitor also active

#### Phase 3 Tests

- Structured log output: unit test verifying log format, field presence
- Health check: integration test with QMD down → health returns unhealthy
- Metrics: unit test for counter increment, percentile calculation

---

### Phase 4: Portal

**Goal:** An authenticated web app at `grove.md` (or `app.grove.md`) where the vault owner manages their grove — keys, trails, usage, vault health — and later browses their knowledge visually. This is the owner's control plane.

**Prerequisites:** Phase 3 observability in place (dashboard needs metrics to display).

**What exists:** `grove-www` (Next.js 16 on Vercel at `grove.md`) — note viewer with markdown rendering, Cmd+K search, directory browsing, magic link + API key auth. Server-side API proxy to `api.grove.md`. No ops dashboard or key management UI yet.

**Key architectural decisions:**
- **Next.js on Vercel.** The API stays on the VPS (`api.grove.md`). The frontend is a separate app that talks to it.
- **Auth: magic link + API key.** Magic link flow creates an auto-provisioned read-only API key via auth code exchange. API key paste still supported.
- **The portal never writes to the vault.** It manages Grove infrastructure (keys, trails, config) and reads vault state (health, metrics, graph). Vault writes stay in Claude via MCP.

#### Phase 4a: Shell + Auth ✅ COMPLETE

- [x] **P4-1: Next.js app scaffold**
  `grove.md` — Next.js 16 App Router on Vercel. Tailwind CSS v4, Lora/Inter/Geist Mono fonts. Warm editorial design system (cream/ink/moss/harvest/earth).

- [x] **P4-2: Admin auth**
  Two auth paths: (1) API key paste → encrypted into `grove_token` cookie, (2) Magic link email → auth code exchange → auto-provisioned API key → same cookie. Both use AES-256-GCM encrypted cookie with 30-day expiry.

- [x] **P4-3: Auth middleware (proxy.ts)**
  Next.js 16 proxy file checks `grove_token` cookie on all routes. Unauthenticated users redirect to `/login?redirect=<path>`. Public paths (`/`, `/login`, `/api/auth`) exempt.

#### Phase 4b: Ops Dashboard

Implementation splits into two batches: backend API additions (grove repo), then frontend pages (grove-www repo). Backend first because the frontend depends on the endpoints existing.

##### Batch 1: Backend API additions (grove repo)

All new admin endpoints go behind `adminAuth()` in `src/proxy.ts`. They use cookie (session) or Bearer auth, same as `/keys`.

- [ ] **P4-API-1: Trail CRUD HTTP endpoints**

  Add to `src/proxy.ts`, after the `/keys` handler. Import `loadTrails`, `createTrail`, `disableTrail`, `deleteTrail` from `./trails.js`.

  **`POST /v1/admin/trails`** — list, create, update, or delete (action-based, same pattern as `/keys`):
  ```
  { action: "list" }
  → { trails: [{ id, name, description, enabled, allow_tags, deny_tags, allow_types, deny_types, allow_paths, deny_paths, rate_limit_reads, rate_limit_writes, created_at }] }

  { action: "create", name: "AI Research", allow_tags: ["ai"], allow_paths: ["Resources/"], deny_paths: ["Journal/", "Areas/"] }
  → { trail: { id, name, ... }, token: "grove_live_..." }

  { action: "update", id: "trail_xxx", enabled: false }
  → { updated: "trail_xxx" }

  { action: "delete", id: "trail_xxx" }
  → { deleted: "trail_xxx" }
  ```

  Existing functions in `src/trails.ts`: `loadTrails()` returns all trails with parsed config. `createTrail(opts)` creates trail + auto-creates scoped API key (returns trail + raw token). Check `src/trails.ts` for exact signatures.

  Need to add `updateTrail(id, updates)` to `src/trails.ts` — updates `config_json` and/or `enabled` flag on the trail row.

  **Files:** `src/proxy.ts` (new route), `src/trails.ts` (add `updateTrail`)
  **Tests:** `test/trails.test.ts` — add updateTrail unit test

- [ ] **P4-API-2: User list endpoint + fix last_login_at**

  **`GET /v1/admin/users`** — returns all users. Requires `adminAuth()`.
  ```
  → { users: [{ id, username, email, created_at, last_login_at }] }
  ```

  Also fix: `last_login_at` is never written. In `src/auth.ts`, the `verifyMagicLink()` function already updates `last_login_at`. But `createSession()` (called from `POST /admin/login` API key flow) does not. Add `db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, userId)` to `createSession()` in `src/auth.ts`.

  **Files:** `src/proxy.ts` (new route), `src/auth.ts` (fix createSession)

- [ ] **P4-API-3: Fix /keys list + /metrics improvements**

  1. Add `expires_at` to the `/keys` list response. In `src/proxy.ts`, the list action's SELECT already fetches `*` but the response mapping omits `expires_at`. Add it.

  2. Merge search stats into `/metrics`. In `src/proxy.ts`, the `/metrics` handler calls `metrics.getMetrics()`. The `SearchTracker` instance (`searchMetrics` in `src/metrics.ts`) has `getSearchStats()` but it's never called from the endpoint. Update the handler to merge:
     ```ts
     sendJson(res, 200, { ...metrics.getMetrics(), search: searchMetrics.getSearchStats() });
     ```
     Check if `searchMetrics` is exported from metrics.ts — it may need to be.

  3. Add auth to `/metrics`. Currently unauthenticated. Gate behind `adminAuth()`.

  **Files:** `src/proxy.ts` (3 small changes), possibly `src/metrics.ts` (export searchMetrics)

- [ ] **P4-API-4: Add git status to vault stats**

  Add a `git` section to `VaultStats` in `src/vault-stats.ts`. Compute during `computeVaultStats()`:
  ```ts
  git: {
    last_commit_at: string,     // git log -1 --format=%cI
    last_commit_msg: string,    // git log -1 --format=%s
    uncommitted_changes: number, // git status --porcelain | wc -l
    branch: string,             // git rev-parse --abbrev-ref HEAD
  }
  ```
  Use `execSync()` with `{ cwd: vaultPath, encoding: "utf-8" }`. Wrap in try/catch — if git fails, return null for the section.

  **Files:** `src/vault-stats.ts` (add computeGitSection + merge into stats)

  **Acceptance criteria:**
  - `GET /v1/stats?sections=git` returns git section with last_commit_at, branch, uncommitted_changes
  - Git failure doesn't crash stats computation

##### Batch 2: Frontend pages (grove-www repo)

All dashboard pages live under `src/app/dashboard/`. Each is a server component with auth check. The dashboard section needs:
- A layout at `src/app/dashboard/layout.tsx` with sub-navigation
- API proxy routes under `src/app/api/admin/` to forward requests to api.grove.md
- Page components for each view

**grove-www conventions** (every agent must follow):
- Colors: `text-ink`, `bg-cream`, `text-moss`, `text-harvest`, `bg-surface`, `border-surface-border` only. No raw Tailwind palette.
- Opacity: only `/60`, `/40`, `/15`. No other values.
- Typography: headings in `font-serif font-medium`, body in `font-sans`. Only weights 400/500.
- Section labels: `text-ink/40 text-label tracking-[0.15em] uppercase mb-4`
- Page content: `<div className="max-w-3xl mx-auto px-6 py-8">`
- Primary button: `bg-ink text-cream px-7 py-3.5 text-sm font-medium hover:bg-earth transition-colors active:scale-[0.98]`
- Secondary button: `border border-ink/15 px-7 py-3.5 text-sm text-ink hover:bg-ink/5 transition-colors`
- Icons: inline Lucide SVGs (no package import). `text-muted` rest, `hover:text-foreground`.
- Server components default. `"use client"` only for interactivity.
- Auth: `const cookieStore = await cookies(); const apiKey = getApiKey(cookieStore);` then redirect if null.
- Data fetching: server components call functions in `src/lib/grove-api.ts` which hit `api.grove.md` with Bearer auth. Client-side data goes through `/api/` proxy routes.

- [ ] **P4-FE-0: Dashboard layout + API proxy routes**

  **`src/app/dashboard/layout.tsx`** — server component. Auth check (redirect to `/login` if no cookie). Renders a sub-navigation bar below the main header with tabs: Overview, Keys, Trails, Usage.

  ```tsx
  // Sub-nav items
  const NAV = [
    { label: "Overview", href: "/dashboard" },
    { label: "Keys", href: "/dashboard/keys" },
    { label: "Trails", href: "/dashboard/trails" },
    { label: "Usage", href: "/dashboard/usage" },
  ];
  ```

  Style: horizontal tabs with `text-ink/40` inactive, `text-ink border-b-2 border-moss` active state. Use `usePathname()` in a client component for active detection.

  **API proxy routes** (server-side, same pattern as `/api/search`):
  - `src/app/api/admin/keys/route.ts` — proxies POST to `api.grove.md/keys`
  - `src/app/api/admin/trails/route.ts` — proxies POST to `api.grove.md/v1/admin/trails`
  - `src/app/api/admin/users/route.ts` — proxies GET to `api.grove.md/v1/admin/users`
  - `src/app/api/admin/metrics/route.ts` — proxies GET to `api.grove.md/metrics`
  - `src/app/api/admin/stats/route.ts` — proxies GET to `api.grove.md/v1/stats`

  Each proxy route: get API key from cookie, forward with Bearer auth, return JSON response.

  **Also:** Add "Dashboard" link to the header in `src/components/header.tsx` (between the wordmark and search, or as a nav item).

  **`src/app/dashboard/page.tsx`** — the Overview page (P4-7 vault health). See P4-7 spec below.

  **Files:** `src/app/dashboard/layout.tsx`, 5 API routes, `src/components/header.tsx` (add link), `src/app/dashboard/page.tsx`

  **Acceptance criteria:**
  - `/dashboard` shows sub-nav with 4 tabs
  - Clicking tabs navigates between dashboard pages
  - Unauthenticated users redirect to `/login?redirect=/dashboard`
  - Dashboard link visible in header on all app pages

- [ ] **P4-7: Vault health panel (dashboard overview)**

  **Route:** `src/app/dashboard/page.tsx` (the default dashboard page)

  **Data source:** `GET /api/admin/stats` → proxies to `GET /v1/stats?sections=vault,freshness,index,lifecycle,git`

  **Layout:** Grid of stat cards. Each card has a section label, a large number, and supporting detail.

  Cards:
  1. **Notes** — `vault.total_notes` (large number), `vault.by_type` top 3 types as small labels
  2. **Freshness** — `freshness.velocity_7d` notes/day (large), `freshness.today` today, `freshness.stale_90d` stale
  3. **Search index** — `index.indexed_docs` / `index.vault_docs` (e.g., "980 / 1000"), `index.drift` as percentage, `index.embedding_coverage` percentage
  4. **Lifecycle** — horizontal bar showing seeds/sprouts/growing/mature/dormant/withering proportions, colored segments
  5. **Git** — `git.last_commit_msg` (truncated), `git.last_commit_at` as relative time, `git.uncommitted_changes` count
  6. **System** — health status (green/red dot), uptime from `/metrics`

  **Acceptance criteria:**
  - Page loads and shows all 6 cards with real data from the API
  - Cards handle missing data gracefully (loading skeleton, "N/A" for null)
  - Lifecycle bar renders proportionally
  - Git section shows last commit info

- [ ] **P4-4: Key management page**

  **Route:** `src/app/dashboard/keys/page.tsx`

  **Data source:** `POST /api/admin/keys` with `{ action: "list" }`, `{ action: "create", name }`, `{ action: "revoke", id }`

  **Layout:**
  - Header: "API Keys" heading + "Create key" button (primary style)
  - Table: columns = Name, Scopes, Vault, Created, Last Used, Expires, Actions
  - Each row: key name, scope badges (`bg-moss/15 text-moss text-xs px-2 py-0.5 rounded`), relative dates, "Revoke" button (destructive: `text-harvest hover:text-harvest/60`)
  - Create flow: clicking "Create key" shows an inline form (key name input + create button). On success, show the token in a `bg-surface font-mono text-sm p-3 rounded` box with a copy button. Warning: "Save this now — it won't be shown again."
  - Revoke flow: confirm dialog ("Revoke key {name}?"), then remove from list on success.

  **Component structure:**
  - `src/app/dashboard/keys/page.tsx` — server component, fetches initial key list
  - `src/components/key-table.tsx` — client component (`"use client"`), handles create/revoke interactions

  **Acceptance criteria:**
  - Lists all API keys with metadata
  - Create key → shows token once → new key appears in table
  - Revoke key → confirm → key disappears from table
  - Empty state: "No API keys. Create one to get started."

- [ ] **P4-5: Trail management page**

  **Route:** `src/app/dashboard/trails/page.tsx`

  **Data source:** `POST /api/admin/trails` with actions: list, create, update, delete

  **Layout:**
  - Header: "Trails" heading + "Create trail" button
  - Card list (not table — trails have more metadata). Each card:
    - Trail name (heading), description, enabled/disabled badge
    - Tags: `allow_tags` as green badges, `deny_tags` as muted/strikethrough
    - Paths: `allow_paths` shown, `deny_paths` shown in muted
    - Rate limits: `rate_limit_reads`/min, `rate_limit_writes`/min
    - Actions: "Disable"/"Enable" toggle, "Delete" button
  - Create flow: modal or inline form with fields: name, description, allow_tags (comma-separated input), deny_tags, allow_types, deny_types, allow_paths, deny_paths, rate_limit_reads, rate_limit_writes. On create, show the consumer API key token (same pattern as key creation).

  **Component structure:**
  - `src/app/dashboard/trails/page.tsx` — server component
  - `src/components/trail-list.tsx` — client component for CRUD interactions

  **Acceptance criteria:**
  - Lists all trails with full configuration
  - Create trail → shows consumer token once → trail appears in list
  - Disable/enable trail → toggles state
  - Delete trail → confirm → trail removed
  - Empty state: "No trails. Create one to share your knowledge."

- [ ] **P4-6: Usage dashboard**

  **Route:** `src/app/dashboard/usage/page.tsx`

  **Data source:** `GET /api/admin/metrics` → proxies to `GET /metrics` (now auth-gated)

  **Layout:**
  - Top row: big numbers — total requests, error rate (%), uptime
  - Tool breakdown: table with columns = Tool, Requests, Errors, p50 (ms), p95 (ms), p99 (ms). Data from `by_tool` keyed by MCP tool names (query, get, multi_get, write_note, list_notes, vault_status).
  - Search stats section (if available): queries in last hour, avg latency, zero-result rate, top queries list

  No charting library needed — use CSS bars or just numbers for v1. Keep it simple.

  **Component structure:**
  - `src/app/dashboard/usage/page.tsx` — server component, fetches metrics
  - Inline display — no complex client-side interactivity needed

  **Acceptance criteria:**
  - Shows total requests, error rate, uptime
  - Tool breakdown table with latency percentiles
  - Search stats section displays if data is present
  - Handles `/metrics` being empty on fresh server start (show "No data yet")

#### Phase 4c: Trail Consumer Pages

- [ ] **P4-8: Consumer onboarding page**

  **Route:** `src/app/trails/[slug]/page.tsx` (public — no auth required)

  **Data source:** Needs a public API endpoint. Add `GET /v1/trails/:id/info` to `src/proxy.ts` in the grove repo — unauthenticated endpoint that returns trail name, description, and note count (no sensitive data). This is the only unauthenticated trail endpoint.

  **Backend addition (grove repo):**
  ```
  GET /v1/trails/:id/info
  → { name, description, note_count, created_at }
  ```
  Implementation: look up trail by ID, count notes matching the trail's filters via a quick scan.

  **Layout:**
  - Full-page, no sidebar/header (add `/trails` to `CHROME_HIDDEN_PATHS` in app-shell.tsx)
  - Centered card layout (same style as login page)
  - Trail name (serif heading), description paragraph
  - Note count: "142 notes available"
  - Two access methods:
    1. **Web:** "Sign in to browse" button → links to `/login`
    2. **MCP:** "Connect via MCP" section with copy-paste config block:
       ```json
       {
         "mcpServers": {
           "grove": {
             "url": "https://api.grove.md/mcp",
             "headers": { "Authorization": "Bearer <your-trail-key>" }
           }
         }
       }
       ```
  - "Get a trail key" link → points to contacting the vault owner (or a future invite flow)

  **Acceptance criteria:**
  - Page loads without auth — public access
  - Shows trail name, description, note count
  - MCP config block is copy-pasteable
  - Non-existent trail ID → 404 page

- [ ] **P4-9: Trail usage view**

  Deferred until P4-5 trail management is working. Will be a detail view within the trail management page showing per-trail request metrics. Requires per-trail metric tracking (not yet implemented — metrics are per-tool, not per-trail).

#### Phase 4d: Knowledge Views (future, after 4b-4c are stable)

These are the views that make the portal more than an admin panel. They surface what's in the vault visually — things that are hard to do in a CLI or chat interface.

- [ ] **P4-10: Graph explorer**
  Interactive visualization of the vault's wikilink graph. Powered by `GET /v1/stats?sections=graph` data. Click a node to see the note's connections, type, lifecycle stage. Filter by type, tag, or cluster. Likely needs a graph visualization library (d3-force or similar). This is the "see the shape of your knowledge" view.

- [ ] **P4-11: Lifecycle dashboard**
  Visual representation of `GET /v1/stats?sections=lifecycle` — seeds, sprouts, growing, mature, dormant, withering. Click a lifecycle stage to see the notes in it. The daily `/garden` practice, but visual.

- [ ] **P4-12: Search playground**
  Try queries against the vault from the browser. See BM25 vs vector scores side-by-side. Useful for tuning search and understanding why results rank the way they do. Developer tool, not a consumer feature.

#### Phase 4 Execution Strategy

**Batch 1 — Backend APIs + dashboard layout (4 parallel agents):**

Each backend agent works in an isolated worktree on the grove repo. To avoid merge conflicts in proxy.ts, agents insert routes at specific anchor points:

- **Agent A:** P4-API-1 (trail CRUD) — Insert trail routes after the `/v1/stats` handler, before the `// Unknown /v1/ route` fallthrough. Touch `src/trails.ts` (add `updateTrail`). Also update CORS: the `/v1/` OPTIONS handler only allows `GET, OPTIONS` — add `POST, PATCH, DELETE` for admin endpoints.
- **Agent B:** P4-API-2 (user list + last_login_at) — Insert user route after the `/v1/list` handler, before `/v1/stats`. Touch `src/auth.ts` (fix createSession).
- **Agent C:** P4-API-3 (keys/metrics fixes) — Modify existing `/keys` and `/metrics` handlers. No new route blocks — just editing existing ones. Zero overlap with A/B.
- **Agent D:** P4-API-4 (git stats) — Only touches `src/vault-stats.ts`. Zero proxy.ts conflict.

Import ordering: Agent A adds imports after the trails import (line ~45 in proxy.ts). Agent B adds after the rest import (line ~46). This gives enough separation for clean merges.

In parallel on the grove-www repo:
- **Agent E:** P4-FE-0 (dashboard layout + all 5 API proxy routes + header link + dashboard overview stub)

Merge backend agents first, deploy. Then merge Agent E.

**Batch 2 — Frontend pages (3 parallel agents, after Batch 1):**

All three need the dashboard layout from Agent E and the backend APIs from Agents A-D to be merged.

- **Agent F:** P4-4 (key management page at `/dashboard/keys`)
- **Agent G:** P4-5 (trail management page at `/dashboard/trails`)
- **Agent H:** P4-7 + P4-6 (vault health overview + usage page at `/dashboard` and `/dashboard/usage`)

Each creates separate pages/components — no file overlap. Merge all, deploy to Vercel.

**Batch 3 — Consumer page:**
- **Agent I:** P4-8 (trail onboarding at `/trails/[slug]` — needs backend endpoint `GET /v1/trails/:id/info` + grove-www page)

#### Phase 4 Acceptance Criteria

- [ ] `/dashboard` loads with sub-nav (Overview, Keys, Trails, Usage)
- [ ] Overview page shows vault stats, lifecycle bar, git status, system health
- [ ] Keys page lists all keys, create shows token once, revoke confirms and removes
- [ ] Trails page lists all trails with config, create shows consumer token, enable/disable works
- [ ] Usage page shows request counts, error rate, latency percentiles per tool
- [ ] `/trails/<id>` loads without auth, shows trail info and MCP config
- [ ] All pages follow the design system (cream/ink/moss, Lora headings, opacity grammar)
- [ ] Unauthenticated dashboard access redirects to `/login?redirect=/dashboard`
- [ ] All data refreshes on page load (no stale cache issues)

---

### Phase 5: Trails

**Goal:** Share shaped slices of your knowledge with others through **trails** — topic-scoped windows into the grove with server-side filtering.

**Prerequisites:** Phase 2 security hardened, Phase 3 observability live, Phase 4 portal exists.

A trail is: a name + topic boundaries (tags, types, paths to allow/deny) + an optional semantic topic description + permission level + API key. Consumers connect via MCP with a trail-scoped key and see only what the trail allows.

**Key architectural decisions:**
- **Filtering happens in the server layer** (`src/server.ts`), not the proxy. Server has access to frontmatter, tags, and the search pipeline.
- **Proxy resolves trail context** — looks up which trail a key belongs to, passes trail config as request metadata to the server.
- **No new MCP tools.** The 6 existing tools behave differently under trail-scoped keys (see below).
- **Ship without LLM judge.** Tag/type/path prefilter covers 90% of cases. Add LLM judge later as a soft signal (demote, don't hard-exclude) only if prefilter proves too coarse. *(Expert recommendation: defer LLM judge until real edge cases prove the need.)*

#### How MCP tools behave under trail-scoped keys

| Tool | Trail behavior |
|------|---------------|
| `query` | Search full index for recall, then strip non-trail notes from results before returning. Include `filtered_count` in response so consumers know results were scoped. |
| `get` | Return **404** (not 403) for notes outside the trail. 403 leaks that the note exists. |
| `multi_get` | Same as `get` — silently omit non-trail notes from results. |
| `list_notes` | Only return trail-visible notes. Essential — otherwise consumers see paths they can't access. |
| `write_note` | If trail access includes write, constrain to trail-allowed paths/tags. Reject writes that create notes outside trail scope. |
| `vault_status` | Return scoped stats: note count and types within trail only. Don't expose full vault metrics. |

#### Trail config data model

```typescript
interface Trail {
  id: string;              // trail_<8hex>
  name: string;            // "AI Research"
  description: string;     // Consumer-facing — what they see when connecting
  topic_description: string; // Semantic — used by future LLM judge
  allow_tags: string[];    // Notes must have at least one
  deny_tags: string[];     // Notes with any of these are excluded
  allow_types: string[];   // e.g., ["concept", "project"]
  deny_types: string[];    // e.g., ["journal"]
  allow_paths: string[];   // e.g., ["Resources/Concepts/", "Resources/Projects/"]
  deny_paths: string[];    // e.g., ["Areas/Health/", "Areas/Finances/"]
  access: "search" | "read" | "write";
  key_ids: string[];       // Associated API keys
  max_results: number;     // Per-trail result cap (default 25)
  enabled: boolean;        // Disable without deleting
  created_at: string;      // ISO 8601
  updated_at: string;      // ISO 8601
}
```

Stored in `~/.grove/trails.json`. Creating a trail auto-generates a scoped API key.

#### Trail info in MCP handshake

On MCP `initialize`, if the session is trail-scoped, return trail metadata (name, description, note count) in the server capabilities. Consumer knows what they're working with without a new tool.

#### Phase 5a: Trail Infrastructure

- [x] **P5-1: Trail config schema** (`src/trails.ts`)
  CRUD operations on `~/.grove/trails.json`. Validate schema, generate IDs, wire to API keys.

- [x] **P5-2: Trail CRUD CLI**
  `grove trails create "AI Research" --allow-tags "ai,llm,agents" --deny-tags "health,finances" --allow-paths "Resources/"`
  `grove trails list` / `grove trails disable <id>` / `grove trails delete <id>`
  Creating a trail auto-creates a scoped API key (token shown once).

- [x] **P5-3: Trail resolution in proxy**
  On auth, look up key → trail mapping. Pass trail config to server as request context (`X-Trail-Config` header). No trail = full access (owner key). Per-trail rate limits enforced.

- [x] **P5-4: Server-side filtering** (`src/server.ts`)
  Fast deterministic prefilter: check note frontmatter tags/types/paths against trail allow/deny lists. Sub-millisecond per note. Applied in all 6 MCP tools. LLM judge deferred to Phase 6.

- [x] **P5-5: `filtered_count` in query responses**
  Include `{ total_found, visible, filtered }` counts so consumers know when results were scoped.

- [x] **P5-6: Trail info in MCP initialize**
  Return trail name, description in MCP server capabilities for trail-scoped sessions.

#### Phase 5b: Safety & Eval

- [x] **P5-7: Tag hygiene audit**
  Audited 2026-04-11: 160/1083 notes (15%) have tags. Path-based filtering is the primary mechanism. The AI trail uses both `allow_paths` and `allow_tags` — paths do the heavy lifting. No action needed; tag coverage is low but trails work because they combine tag + path filters.

- [x] **P5-8: Trail filter eval suite**
  Labeled test cases: 20 known-sensitive notes and 20 known-safe notes. 100% precision (zero leaks) and 100% recall on labeled dataset. Tests in `test/trails.test.ts`.

- [x] **P5-9: Audit trail for trail access**
  Every trail access logged via structured logger: `{ trail_id, trail_name, tool, total_count, filtered_count }`. Uses `logTrailAccess()` in `src/trails.ts`.

- [x] **P5-10: Blast radius limits**
  Per-trail rate limits: configurable max reads/min, max writes/hour. Default: 60 reads/min, 10 writes/hour per trail. Separate from owner key limits.

- [x] **P5-11: Snapshot/rollback**
  `grove snapshot` creates a git tag. `grove rollback <tag>` reverts. Automatic snapshot before any bulk operation.

#### Phase 5c: Portal Integration (deferred to Phase 4)

Trail management UI (P4-5), consumer onboarding pages (P4-8), and trail usage views (P4-9) are now part of the Phase 4 Portal. The trail backend is ready — these are frontend tasks.

#### Phase 5 Tests

- Filter accuracy: labeled dataset, precision/recall thresholds
- 404 vs 403: verify hidden notes return 404
- Scope enforcement: trail-scoped key can't access notes outside trail
- Write constraints: trail with read access can't write; trail with write access can't write outside scope
- End-to-end: create trail → generate key → connect as consumer → search → verify filtering
- Load test: concurrent trail-scoped requests don't bottleneck (especially when LLM judge is added later)

---

### Phase 6: LLM Judge (deferred)

**Goal:** Add semantic content filtering for trail edge cases where tag/type/path filtering is too coarse.

**Prerequisites:** Phase 5 shipped. Real edge cases documented from trail usage. Tag hygiene audit shows gaps.

- [ ] **P6-1: Install Ollama on VPS** — bind to `127.0.0.1:11434`, run in cgroup with memory/CPU limits. T4 has ~15GB VRAM headroom after TEI (~1GB).
- [ ] **P6-2: Qwen2.5-3B generative model** — via Ollama, for judge inference.
- [ ] **P6-3: Judge integration** — soft signal layer after tag prefilter. Evaluates survivors against `topic_description`. Demotes (reranks lower), does not hard-exclude. Logs every decision.
- [ ] **P6-4: Judge eval suite** — labeled test cases, precision >95%, recall >90%. Measure latency impact. Run as `npm run test:judge`.
- [ ] **P6-5: Judge toggle** — per-trail `use_judge: boolean`. Off by default. Enable for trails where prefilter isn't enough.

---

### Phase 7: Discovery & Onboarding

**Goal:** Knowledge grows autonomously. New content integrates without manual invocation.

**Prerequisites:** Phases 2-5 stable. Safety infrastructure proven.

#### Phase 7a: Background Discovery

- [ ] **P7-1: Discovery loop**
  Background process on VPS, triggered by git commits and write_note calls. For each changed note: extract entities/concepts, check if concept notes exist, create if not, wire wikilinks.

- [ ] **P7-2: Concept extraction**
  Use local LLM (Ollama, from Phase 6) to identify concepts, people, projects from note content. Match against existing vault entities (via list_notes + aliases). Create new concept notes for genuinely new entities.

- [ ] **P7-3: Semantic neighbor surfacing**
  For each new/changed note, find embedding-similar notes that aren't already linked. Log surprising connections to a discovery feed.

- [ ] **P7-4: Discovery digest**
  New `vault_status` mode: `discovery`. Returns what the loop found recently — new concepts created, new links wired, surprising connections. Powers the `/garden` daily practice.

- [ ] **P7-5: Bookmark integration**
  X bookmarks (via `bird` CLI) become a trigger for the discovery loop, not a manual `/garden-forage` invocation. Cron or webhook watches for new bookmarks, ingests them, extracts concepts.

#### Phase 7b: Bulk Onboarding

- [ ] **P7-6: Ingest command**
  `grove ingest <dir>` — reads a directory of files, parses frontmatter/content, deduplicates against existing vault, writes new notes via write_note.

- [ ] **P7-7: Concept bootstrapping**
  After ingest, run discovery loop over all new notes to extract concepts and build the initial graph. This is the cold start path for new users or new content dumps.

---

### Phase B: Magic Link Auth & Cross-Domain Sessions ✅ COMPLETE 2026-04-11

**Goal:** Replace in-memory admin sessions with persistent SQLite-backed auth. Add magic link login as a path from "person with an email" to "authenticated user with an API key." Bridge auth between `api.grove.md` and `grove.md`.

**What was built:**

The auth system shifted from "single admin with a pasted API key" to "users with email-based identity and persistent sessions." This is the foundation that makes multi-user collaboration possible.

**Auth architecture (new):**

```
grove.md/login                     api.grove.md
┌──────────────┐                   ┌──────────────────────┐
│ Email form   │───POST──────────→ │ /auth/magic-link     │
│              │                   │ → store hashed token  │
│              │                   │ → send email (Resend) │
└──────────────┘                   └──────────────────────┘
                                           │
                                     email with link
                                           │
                                           ▼
                                   ┌──────────────────────┐
                                   │ /auth/verify (GET)    │
                                   │ → confirm page + CSRF │
                                   │ /auth/verify (POST)   │
                                   │ → verify magic link   │
                                   │ → create auth code    │
                                   │ → redirect to grove.md│
                                   └───────────┬──────────┘
                                               │ 302 + ?code=
                                               ▼
grove.md/api/auth/callback         api.grove.md
┌──────────────┐                   ┌──────────────────────┐
│ Exchange code│───GET────────────→│ /auth/exchange       │
│              │←── session_token ─│ → validate code      │
│ Create key   │───POST───────────→│ /keys (create)       │
│              │←── API key token ─│ → grove-www-<user>   │
│ Set cookie   │                   └──────────────────────┘
│ Redirect /   │
└──────────────┘
```

**Key components:**
- `src/auth.ts` — magic link requests (rate-limited 3/email/15min), verification (single-use, 15min TTL), session CRUD (30d sliding / 90d absolute), auth code exchange (60s TTL, single-use), CSRF tokens
- `src/email.ts` — Resend API (prod) or console.log (dev)
- `src/db.ts` — `users`, `sessions`, `magic_links`, `auth_codes` tables in `~/.grove/grove.db`
- `src/proxy.ts` — 6 new routes (`/auth/magic-link`, `/auth/verify` GET+POST, `/auth/exchange`, `/auth/session`, `/auth/logout`)
- `grove-www/src/app/login/page.tsx` — email + API key dual login form
- `grove-www/src/app/api/auth/callback/route.ts` — code exchange + auto key provisioning
- `grove-www/src/app/api/auth/magic-link/route.ts` — server-side proxy (avoids CORS)

**Security properties:**
- Raw tokens never stored — SHA-256 hashes only (magic links, sessions, auth codes)
- Magic links: single-use, 15min TTL, 3/email/15min rate limit
- Sessions: HttpOnly, Secure, SameSite=Lax cookies, sliding + absolute expiry
- Auth codes: single-use, 60s TTL (just long enough for the redirect)
- No email enumeration: requestMagicLink always returns 200

**What this enables:** Users exist as first-class entities in the database. A person with only an email can get authenticated, get an API key, and access the vault. This is the primitive that multi-user collaboration (Phase 9) builds on.

---

### Phase 8: Multi-Vault (deferred)

**Goal:** Add additional vaults (e.g., work vault `~/canva/`) as separate queryable indexes.

**Prerequisites:** Phases 5-7 stable.

This was originally Phase 2 but deferred — trails and discovery are higher impact than multi-vault support. The work vault is read-only and auto-generated; it can wait.

- [ ] **P8-1: Multi-vault config** — per-vault QMD indexes, config.json
- [ ] **P8-2: Per-vault keys** — keys scoped to vault_id
- [ ] **P8-3: Read-only vaults** — config flag, 403 on writes
- [ ] **P8-4: Cross-vault search** — merged RRF, tagged results
- [ ] **P8-5: Graph isolation** — per-vault backlinks, opt-in cross-vault traversal

---

### Phase 9: Multi-User & Collaboration

**Goal:** Move Grove from "one vault owner sharing read-only trails" to "multiple users with their own identities, permissions, and collaborative workflows."

**Prerequisites:** Phase B (magic link auth) complete. Phase 4b (ops dashboard) in progress or complete.

**Context:** Phase B established the foundation — users exist in the database, magic links create identity, sessions persist. But today there's exactly one user (`user_00000000`), everyone shares the same vault, and "collaboration" means handing someone a trail-scoped read-only key. This phase builds the layers that turn Grove into something multiple people can use together.

#### The collaboration spectrum

Not every user needs the same access. The phases below build progressively:

1. **Invited readers** — owner shares a note or trail, recipient signs in with email, reads scoped content on `grove.md`
2. **Commenters/annotators** — readers can leave notes/reactions on shared content (stored separately from the vault)
3. **Contributors** — trusted users can write to specific paths in the vault (e.g., a shared project area)
4. **Vault owners** — each user has their own vault, hosted on Grove (multi-tenant)

Phase 9 covers (1) and (2). Steps (3) and (4) are Phase 10+ territory.

#### Phase 9a: User Management

- [ ] **P9-1: User roles**
  Add `role` column to users table. Roles: `owner` (full access), `member` (trail-scoped access), `viewer` (read-only trail access). Owner is the vault admin. Members and viewers are invited by email.

- [ ] **P9-2: Invite flow**
  `grove invite <email> --trail <trail-id> --role viewer` CLI command. Creates user record if needed (email only, no password). Sends magic link email with a welcome message. On first login, user gets a scoped API key for their assigned trail.

  API: `POST /admin/invite` — creates user + trail grant + sends magic link. Requires owner auth.

- [ ] **P9-3: User-scoped keys**
  Today all keys are owned by `user_00000000`. After P9-3, keys are scoped to their creating user. A viewer's auto-provisioned key only grants access to the trails they've been invited to. The `adminAuth()` function checks user role — only `owner` can manage keys and trails.

- [ ] **P9-4: User management UI**
  Page on `grove.md` (owner-only): list users, invite new users, assign trails, revoke access. Shows: email, role, last login, assigned trails, key count.

#### Phase 9b: Trail Sharing UX

- [ ] **P9-5: Shareable trail links**
  Public onboarding page per trail: `grove.md/trails/<trail-slug>`. Shows trail name, description, note count, and a "Sign in to access" button. No login required to see the page — but reading notes requires auth.

  For MCP users: the page shows copy-paste connection config for Claude.ai, Cursor, etc.

  For web users: "Sign in with email" → magic link → lands on `grove.md` with trail-scoped access.

- [ ] **P9-6: Trail-scoped grove.md experience**
  When a viewer/member signs in via a trail link, their `grove.md` session is scoped to that trail. They see the trail name in the header, search only returns trail-visible notes, and navigation is limited to trail-allowed paths. The sidebar/breadcrumbs only show what they can access.

  Implementation: the auto-provisioned API key has trail-scoped access. The existing server-side filtering handles the rest — no frontend logic needed beyond showing the trail context.

- [ ] **P9-7: Share-a-note links**
  Owner can generate a shareable link to a specific note: `grove.md/s/<short-id>`. The link creates a temporary trail scoped to that single note (and its immediate backlinks). Recipient signs in with email, sees the note. Link expires after a configurable TTL (default 7 days).

  Implementation: a `shared_links` table with `note_path`, `created_by`, `expires_at`, `max_views`. The share creates a micro-trail at access time.

#### Phase 9c: Annotations & Reactions

- [ ] **P9-8: Annotations layer**
  Viewers and members can leave annotations on notes. Annotations are stored in Grove's SQLite database (not in the vault markdown). Schema:
  ```sql
  CREATE TABLE annotations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    note_path TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );
  ```
  Annotations appear on `grove.md` below the note content. The vault owner sees all annotations; viewers see their own + the owner's replies.

- [ ] **P9-9: Annotation API**
  `POST /v1/notes/:path/annotations` — create annotation (requires auth, any role).
  `GET /v1/notes/:path/annotations` — list annotations (filtered by visibility rules).
  `DELETE /v1/notes/:path/annotations/:id` — delete own annotation or any (owner only).

- [ ] **P9-10: Annotation notifications**
  When someone annotates a note, the vault owner gets an email summary (batched daily, not per-annotation). Configurable: per-trail notification settings.

#### Phase 9 Design Decisions

| Decision | Chosen | Why |
|----------|--------|-----|
| User creation | Invite-only (owner sends magic link) | No public signup. Grove is private-first. Access is granted, not requested. |
| Annotation storage | Grove SQLite, not vault markdown | Annotations are social metadata, not knowledge. They shouldn't pollute the vault's git history or show up in Claude's MCP tools. |
| Viewer experience | Trail-scoped grove.md, same codebase | No separate app for viewers. The existing grove-www handles it — the API key's trail scope does the filtering. |
| Share links | Micro-trails, not public URLs | Even shared notes require email auth. No anonymous access. This is a deliberate privacy choice. |
| Roles | owner/member/viewer | Minimal. Don't add "editor", "admin", "moderator" until there's a real need. Three roles cover the collaboration spectrum for now. |

#### Phase 9 Success Criteria

- Owner invites a collaborator by email → they receive a magic link → click it → land on grove.md seeing only their trail's notes
- Viewer searches and only gets trail-scoped results (no leaks)
- Viewer leaves an annotation on a note → owner sees it on grove.md and in a daily email
- Share-a-note link works: recipient opens it, signs in, sees the note + backlinks
- Share link expires after TTL — accessing it returns "link expired"
- Owner can see all users, their roles, last login, and assigned trails in the management UI
- Revoking a user's access immediately invalidates their keys and sessions

---

## Design Decisions Log

Decisions made during planning. Reference these when implementing — don't re-litigate settled questions.

| Decision | Chosen | Alternatives considered | Why |
|----------|--------|------------------------|-----|
| API style | Domain (knowledge API) | Filesystem (read/write/glob) | Agents need structured data, not raw markdown. Fewer tools = better tool selection. |
| Endpoint count | 6 MCP tools | 15 filesystem primitives | AI tool selection degrades past ~10 tools. |
| Write concurrency | Serialized queue (mutex) | Git merge, CRDTs | Git merge corrupts YAML frontmatter. CRDTs are overkill for single-user. Mutex is simple and correct. |
| Sync direction | Server writes, local pulls | Bidirectional | Prevents split brain. One source of truth for remote writes. |
| Obsidian Sync | Disabled (git only) | Keep both | Two sync systems = conflicts. Git handles everything. |
| Embeddings | Self-hosted TEI (bge-base-en-v1.5) | OpenAI API, local sentence-transformers | Privacy-first. Same model on Mac (embedding) and VPS (query). No data leaves our infra. |
| Embed runtime | Node.js (embed-node.ts) | Python sentence-transformers | Python 3.14 + sqlite-vec vec0 = catastrophic GC (25-47GB). Node.js + better-sqlite3 works perfectly. |
| Search pipeline | BM25 + vector + RRF | + grep + reranker + query expansion | Over-engineered for <10K docs. Reranker/expansion add latency, not quality at this scale. |
| Garden API design | Workflows compose 6 primitives | Dedicated endpoints per garden operation | Plant/harvest compose naturally. Tend/wander need server-side computation folded into `vault_status`. |
| MCP server | Proper SDK-based server | Extend proxy interceptors | Expert panel unanimous: interceptors are tech debt. Proxy stays for auth, Grove server owns the tools. |
| Write sync | VPS writes + pushes, Mac pulls | Mac-only writes | Closes the two-way loop. Push retry with rebase-abort handles conflicts. |
| Auth tokens | SHA-256 hashed, scoped, prefixed | Simple bearer strings | Hashing survives token leaks. Scopes survive multi-user. Prefix enables secret scanning. |
| Vault scoping | In URL path from day 1 | Implicit single vault | `/v1/vaults/{id}/` is free now, breaking change later. |
| Language | TypeScript | Go, Python | QMD is TypeScript. MCP SDK is TypeScript. Same ecosystem. |
| HTTP framework | None (raw node:http) | Express, Fastify | Server is <2K LOC. No framework needed. |
| TLS | nginx + certbot | Caddy, built-in | Already running on VPS, certbot auto-renews. |
| Agent deletes | Not allowed | Allowed with scope | Probabilistic systems should not delete personal data. |
| Git push cadence | Batched every 30s | Per-write | Cleaner history, fewer push/pull races. |
| Scoped access naming | Trails | Views, lenses, channels, gardens | Extends the grove metaphor naturally — trails are paths through a grove. |
| Trail boundaries | Two-layer: tag/type/path prefilter + deferred LLM judge | Semantic-only, path-only, tag-only | Prefilter is fast and deterministic, covers 90%. LLM judge deferred until real edge cases prove need. |
| Trail filter location | Server layer (`server.ts`) | Proxy layer | Server has frontmatter, tags, search pipeline. Proxy only resolves trail context. |
| Hidden note response | 404 (not 403) | 403 Forbidden | 403 leaks that the note exists. 404 is indistinguishable from non-existent. |
| Encryption at rest | EBS encryption (AWS-managed) | LUKS, git-crypt, defer | LUKS is wrong for AWS — volume is decrypted at runtime. EBS encryption is free, automatic, protects snapshots. |
| Monitoring | BetterStack | Grafana Cloud, custom-built | Free tier covers this scale. Uptime + logs + alerting in one product. |
| Metrics format | JSON `/metrics` endpoint | Prometheus exposition | No scraper needed at this scale. Internal counters serve the dashboard directly. |
| Dashboard data source | Internal counters | BetterStack API | Avoids external dependency for own dashboard. Counters reset on restart (fine). Daily rollups to SQLite for history. |
| Admin auth | Magic link + API key + persistent SQLite sessions | GitHub OAuth, passkey, JWT | Magic links are frictionless and establish email identity. Sessions survive restarts. Foundation for multi-user. |
| Cross-domain auth | Auth code exchange (one-time code redirect) | Shared cookie domain, iframe, proxy all requests | Auth codes are single-use, 60s TTL, don't require same domain. Frontend keeps working with Bearer auth unchanged. |
| Email delivery | Resend API (one fetch call) | SES, Mailgun, custom SMTP | Minimal integration — one fetch, no SDK. Dev mode falls back to console.log. |
| Annotation storage | Grove SQLite (not vault markdown) | Inline in notes, separate annotation files | Social metadata shouldn't pollute vault git history or appear in MCP tools. |
| User creation | Invite-only (owner sends magic link) | Public signup, OAuth providers | Grove is private-first. Access is granted, not requested. |
| LLM judge | Deferred (Phase 6) | Ship with trails, rule-based only | Expert panel: prefilter covers 90%, LLM adds latency and fragility. Ship without, add when proven needed. |
| Ollama binding | 127.0.0.1 only, cgroup-limited | 0.0.0.0 (default) | Default binds to all interfaces — security risk. Cgroup prevents resource starvation of main app. |
| Consumer discovery | `filtered_count` in responses | Hide filtering entirely | Consumers should know results are scoped so they can request broader access. |
| Portal framework | Next.js on Vercel | Extend node:http server with HTML routes | API server stays minimal (raw node:http). Portal is a separate app with real framework needs (routing, auth middleware, SSR). Vercel deployment is free for this scale. |
| Portal scope | Ops first, knowledge views later | Ship graph explorer immediately | Ops dashboard is needed now (key/trail management). Knowledge views are nice-to-have — design the shell so they can grow in, but don't block shipping on them. |
| Portal auth | Admin key + JWT session cookie | OAuth provider, passkey | Single user, single key. Simplest thing that works. Re-evaluate if trail consumers need portal access. |

---

## Constraints

- **No new frontmatter types** without updating the validation list in notes service.
- **No agent-facing delete** — archive only, admin scope only.
- **Max note size:** 100KB. Reject larger writes.
- **Max batch size:** 50 notes per batch_read.
- **Max search results:** 50 per query.
- **Rate limits:** 120 reads/min, 20 writes/min per key.
- **Git commit messages:** Always `"grove (<key-name>): <action> <path>"` format.
- **File extensions:** Only `.md` and `.json` files accessible through the API.
- **Path validation:** Resolve symlinks, reject anything outside vault root. No `..` traversal.

---

## Open Questions (resolve during implementation)

1. ~~**QMD embedding backend:**~~ **Resolved.** Bypassed entirely. TEI handles query embedding on VPS; embed-node.ts handles doc embedding on Mac via TEI over SSH tunnel. QMD's node-llama-cpp is never loaded.

2. **Backlink computation cost:** Grepping the entire vault for `[[Note Name]]` on every read is expensive. Options: (a) cache backlinks and invalidate on write, (b) precompute backlink index on startup, (c) make backlinks a separate endpoint/field. Decide based on vault size and latency requirements.

3. ~~**MCP tool descriptions:**~~ **Resolved.** QMD's built-in MCP tool descriptions work well. The `query` tool accepts structured searches (lex/vec/hyde). Iterate based on Claude.ai usage.

4. ~~**Domain name:**~~ **Resolved.** `api.grove.md`

5. ~~**Auto-embed on vault change:**~~ **Resolved.** Phase 1b (P1-10) added fire-and-forget `embedFile()` after write_note.

6. ~~**Tag hygiene for trails:**~~ **Resolved.** 15% tag coverage (160/1083 notes). Path-based filtering is the primary mechanism. Tags supplement but don't carry trails alone. Current trail config uses both — working correctly.

7. ~~**Admin dashboard exposure:**~~ **Resolved.** Portal is grove-www on Vercel. Auth via magic link + API key with persistent sessions. Cross-domain auth code exchange bridges api.grove.md and grove.md.

8. **Ollama GPU sharing:** TEI uses ~1GB VRAM on the T4 (16GB). Ollama + Qwen2.5-3B needs ~3-4GB. Should be fine, but needs load testing under concurrent requests (search embedding + judge inference simultaneously). Deferred to Phase 6.

---

## Success Criteria

**Phase 0 is successful when:**
- ✅ You can search your vault from Claude.ai on your phone and get relevant results
- ✅ You can read a note and see its content
- ✅ Hybrid search (keyword + semantic) returns high-quality results
- [ ] You've used it daily for 2 weeks and documented what's missing (P0-5b)

**Phase 1 is successful when:**
- Claude.ai can create a concept note, and the next conversation (any surface) finds it via search
- Harvest works: read a journal entry, find people mentioned, create/link entity notes
- Tend works: vault_status(diagnostics) returns orphans, broken links, missing frontmatter
- All writes are traceable in git log to the key that made them
- No data loss or corruption after a week of daily use

**Phase 2 (Security) is successful when:**
- Path traversal tests pass — `../../etc/passwd` returns 400, not file contents
- CORS rejects requests from non-allowed origins
- Read-only keys get 403 on write operations
- EBS volume is encrypted, S3 backups are encrypted
- No plaintext secrets in JSON files

**Phase 3 (Observability) is successful when:**
- Every request produces a structured JSON log line with correlation ID
- `/health` returns unhealthy when QMD or embed server is down
- BetterStack alerts fire within 2 minutes of downtime
- `/metrics` returns request counts, latency percentiles, error rates
- Dead man's switch fires if daily cron stops

**Phase 4 (Portal) is successful when:**
- Owner can log in with admin key, get a session, and manage keys/trails from the browser
- Usage dashboard shows request volume and latency over time
- Vault health panel shows note count, sync status, embedding coverage
- Trail consumer can visit a public onboarding page and copy MCP connection config
- The app feels like a natural extension of the CLI, not a replacement for it

**Phase 5 (Trails) is successful when:**
- Create a trail, generate a consumer key, connect from Claude.ai — consumer sees only trail-scoped results
- Sensitive notes (health, finances) never leak through an AI Research trail (precision >95%)
- On-topic notes aren't over-filtered (recall >90%)
- `filtered_count` appears in query responses
- Trail consumer sees 404 (not 403) for hidden notes
- All trail access is logged in audit trail
- End-to-end: plant a note via owner key → consumer immediately finds it via trail-scoped search

---

## Implementation Order

**Phases 0-1** ✅ — MCP server, hybrid search, read/write, auth, CLI
**Phase 2** ✅ — Path traversal, CORS, body limits, scope enforcement, EBS encryption, S3 backups, OAuth secrets to SQLite, key TTLs
**Phase 3** ✅ — Structured logging, correlation IDs, audit logging, deep health check, metrics, BetterStack (uptime + logs)
**Phase B** ✅ — Magic link auth, persistent SQLite sessions, cross-domain auth code exchange (grove.md ↔ api.grove.md)
**Phase 5** ✅ — Trail config/CLI/filtering/eval/audit/blast-radius/tag-audit/snapshot-rollback

**Phase 4a** ✅ — Next.js app scaffold, auth (magic link + API key), middleware
**Phase 4b — Ops Dashboard (next):**
1. **P4-4 + P4-7** — Key management + vault health (parallel, both read from existing APIs)
2. **P4-5 + P4-6** — Trail management + usage dashboard (parallel, trails backend is ready)
3. **P4-8 + P4-9** — Consumer onboarding page + trail usage view (parallel, lightweight)

**Phase 4d — Knowledge Views (after ops dashboard):**
4. **P4-10 + P4-11 + P4-12** — Graph explorer, lifecycle dashboard, search playground

**Phase 6** — LLM judge (deferred until trail edge cases prove the need)
**Phase 7** — Discovery & onboarding (background discovery loop, concept extraction, bookmark integration)
**Phase 8** — Multi-vault (work vault, cross-vault search)

**Phase 9 — Multi-User & Collaboration (after Phase 4b):**
1. **P9-1 + P9-2 + P9-3** — User roles, invite flow, user-scoped keys (foundational, build together)
2. **P9-4** — User management UI on grove.md (depends on P9-1-3)
3. **P9-5 + P9-6** — Shareable trail links + trail-scoped grove.md experience (parallel)
4. **P9-7** — Share-a-note links with micro-trails
5. **P9-8 + P9-9** — Annotations layer + API (parallel)
6. **P9-10** — Annotation notifications (after annotations work)
