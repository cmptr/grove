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
**Next:** Agent infrastructure (CI/CD, proxy extraction, graceful shutdown) → Ops dashboard (Phase 4b) → Multi-user (Phase 9a) → Discovery (Phase 7) → Knowledge views (P4-10+)

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

## Current State (as of 2026-04-12)

Snapshot for cold-start agents. Verify against live system before acting.

**Services (VPS — api.grove.md, 52.37.76.231):**
| Process | Port | Purpose |
|---------|------|---------|
| `grove-proxy` | 8420 | Auth, OAuth, CORS, rate limiting, request routing |
| `grove-server` | 8190 | MCP server, 6 tools, write queue |
| `qmd-server` | 8177 | BM25 search (FTS5 index) |
| Embedding | Voyage AI API | Vector embeddings (voyage-4-large, 1024-dim) |
| nginx | 443 | TLS termination, reverse proxy to 8420 |

**Database schema (`~/.grove/grove.db`):** `users`, `vaults`, `api_keys`, `trails`, `trail_grants`, `sessions`, `magic_links`, `oauth_clients`, `oauth_codes`, `auth_codes`

**MCP Tools:** `query`, `get`, `multi_get`, `write_note`, `list_notes`, `vault_status`

**Vault:** ~1,083 notes, ~5,600 embeddings, git-tracked at GitHub (private)

**Source modules (25):** `proxy.ts` (1,351 LOC), `server.ts` (820), `hybrid-search.ts` (494), `vault-graph.ts` (462), `vault-stats.ts` (439), `auth.ts` (358), `db.ts` (330), `vault-ops.ts` (286), `embed.ts` (274), `trails.ts` (262), `embed-node.ts` (193), `embed-single.ts` (170), `keys.ts` (172), `metrics.ts` (164), `notes-validate.ts` (136), `rest.ts` (476), `sync-sources.ts` (117), `rate-limit.ts` (118), `logger.ts` (103), `cli.ts` (708), `email.ts` (33), `users.ts` (60)

**Test coverage:** 19 test files, 2,933 LOC, 228 tests, 0.39 test/code ratio. Coverage gaps: proxy.ts (64 LOC of tests for 1,351 LOC), no end-to-end write path test, no integration test harness.

---

## Agent Workflow

How autonomous coding agents should work on this repo. Follow this protocol exactly.

### Branch & PR Protocol

1. Create branch: `agent/<task-id>` (e.g., `agent/p4-api-2`)
2. Implement the task per its spec — do not touch files outside your spec's file list
3. Run `npm test` — all tests must pass
4. Run `npx tsc --noEmit` — must compile clean
5. Commit with descriptive message referencing the task ID
6. Open PR with task ID in title (e.g., `P4-API-2: User list endpoint + fix last_login_at`)
7. CI runs tests + typecheck automatically. If it fails, fix and push.
8. After merge to main, CI deploys automatically. Verify via health check.
9. If broken post-deploy: `git revert <merge-commit>`, open issue, re-spec task.

### File Ownership Rules

When the execution strategy assigns files to specific agents, those are exclusive. Do not modify files outside your assignment. If you discover a bug in another file, document it as a follow-up task — don't fix it in your PR.

### Merge Conflict Resolution

If your branch conflicts with main:
1. `git fetch origin && git rebase origin/main`
2. Resolve conflicts preserving the intent of both changes
3. Re-run `npm test && npx tsc --noEmit`
4. Force-push your branch (not main)

### Testing Requirements

Every new endpoint, function, or behavior change needs tests. The test/code ratio is currently 0.39 — the goal is 0.5+.

**Unit tests (required for every PR):**
- Test the function in isolation. Mock external dependencies (HTTP, filesystem, SQLite).
- **Test file naming:** `test/<module>.test.ts` (match the source file name)
- **Fixtures:** Extend `test/fixtures/vault/` for vault-dependent tests. Document what you added in a comment at the top of the fixture file.
- **Acceptance criteria → tests:** Each acceptance criterion in the task spec maps to at least one test assertion. If the spec says "returns 409 on hash mismatch," there's a test for that.

**REST endpoint tests (required for every new endpoint):**
- Test request → response for success, validation error, auth error, not-found
- Test trail-scoped behavior (filtered results, write scope enforcement)
- Test with `If-Match` header for write endpoints

**CLI command tests (required for every new command):**
- Test JSON output schema matches the contract (parse output, verify fields)
- Test exit codes for success and each error type
- Test `--help` output includes usage, flags, and JSON schema
- Mock HTTP responses (after REST-4 migration) — no live server needed

**What NOT to test:**
- Don't test the framework (node:http, better-sqlite3, vitest itself)
- Don't snapshot test human-formatted output (it changes too often)
- Don't test internal implementation details that could change without affecting behavior

### Documentation Requirements

Documentation is a first-class deliverable, not an afterthought. Agents reading docs should be able to use any CLI command or REST endpoint without reading source code.

**REST API docs (`docs/api.md` — create when REST-2 ships):**
- Every endpoint: method, path, auth, request schema, response schema, error codes
- Examples with curl commands
- Trail filtering behavior per endpoint
- Rate limit information

**CLI docs (`docs/cli.md` — create when CLI-A7 ships):**
- Every command: usage, flags, examples, JSON output schema, exit codes
- Workflow examples showing multi-command composition
- Config setup instructions

**Inline code docs:**
- Exported functions get a JSDoc comment with param types, return type, and one-line description
- Non-obvious logic gets a comment explaining *why*, not *what*
- Don't add docs to internal/private functions unless the logic is genuinely surprising

**Update rules:**
- Adding a REST endpoint? Update `docs/api.md` in the same PR.
- Adding a CLI command? Update `docs/cli.md` in the same PR.
- Changing behavior of an existing endpoint/command? Update the relevant docs in the same PR.
- Don't create docs PRs that are separate from the feature — docs ship with the feature.

---

## Dependency DAG

```
                    ┌─────────────────┐
                    │  P4-PREREQ      │
                    │  CI pipeline    │
                    │  Graceful shutdown│
                    └────────┬────────┘
                             │
         ┌───────────────────┼──────────────────┐
         ▼                   ▼                   ▼
  ┌────────────┐     ┌────────────┐      ┌────────────┐
  │  CLI-A     │     │ Phase 4b   │      │ Phase 7a   │
  │  Foundation│     │ Batch 1    │      │ Discovery  │
  │  --json,   │     │ (4 backend │      │ P7-1..P7-6 │
  │  exit codes│     │  agents)   │      │            │
  └──────┬─────┘     └─────┬──────┘      └──────┬─────┘
         │                 │                     │
         │          ┌──────▼──────┐       ┌──────▼─────┐
         │          │ Phase 4b    │       │ Phase 7b   │
         │          │ Batch 2+3   │       │ Bulk       │
         │          │ (FE agents) │       │ onboarding │
         │          └──────┬──────┘       └────────────┘
         │                 │
         ▼                 │
  ┌────────────┐           │
  │  CLI-B     │◄──────────┘ (needs P4-API-1 for trail HTTP)
  │  Consistency│
  │  --paths,  │
  │  trails HTTP│
  └──────┬─────┘
         │
         ▼
  ┌────────────┐     ┌────────────┐
  │ Phase 9a   │     │ Phase 4d   │
  │ User mgmt  │     │ Knowledge  │
  │ + CLI-D    │     │ views      │
  │ users cmd  │     └────────────┘
  └──────┬─────┘
         │
  ┌──────▼─────┐
  │ Phase 9b   │
  │ Trail UX   │
  │ + CLI-D    │
  │ share cmd  │
  └────────────┘
```

**Key dependency rules:**
- P4-PREREQ must complete before any other phase launches
- CLI-A can start immediately after P4-PREREQ — no server feature dependencies
- Phase 4b Batch 1 can run in parallel with CLI-A
- CLI-B needs CLI-A merged + P4-API-1 (trail HTTP endpoints) merged
- Phase 9a can start after CLI-B (needs `--json` for agent use + trail HTTP)
- Phase 7 has no dependency on CLI work — can run in parallel
- CLI-D commands land alongside their server phases (users with 9a, share with 9b, discovery with 7a)

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

#### Phase 4-PREREQ: Agent Infrastructure

**Goal:** Automated test feedback on PRs and safe process restarts. Two tasks, one agent.

- [ ] **P4-PREREQ-1: GitHub Actions CI** (`.github/workflows/ci.yml`)

  Agents need automated feedback on PRs. Deploy stays manual — the VPS runs the owner's live knowledge API, so deploys should be a human decision.

  **Workflow:**
  ```yaml
  name: CI
  on:
    pull_request:
      branches: [main]
    workflow_dispatch:  # manual deploy trigger

  jobs:
    test:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 22
            cache: npm
        - run: npm ci
        - run: npx tsc --noEmit
        - run: npm test

    deploy:
      needs: test
      if: github.event_name == 'workflow_dispatch'
      runs-on: ubuntu-latest
      steps:
        - name: Deploy to VPS
          uses: appleboy/ssh-action@v1
          with:
            host: 52.37.76.231
            username: deploy
            key: ${{ secrets.DEPLOY_SSH_KEY }}
            script: |
              cd /root/grove
              git pull --ff-only
              npm ci --production
              sudo pm2 restart grove-server grove-proxy
              sleep 5
              curl -sf https://api.grove.md/health || (echo "DEPLOY HEALTH CHECK FAILED" && exit 1)
  ```

  **Setup required:**
  - Add `DEPLOY_SSH_KEY` as a GitHub Actions secret (dedicated deploy key, not admin SSH key)
  - Create a `deploy` user on VPS with restricted sudo (only `pm2 restart`, `git pull` in `/root/grove`)

  **Files:** `.github/workflows/ci.yml`

  **Acceptance criteria:**
  - PRs get automated test + typecheck results
  - Deploy is manual: click "Run workflow" in GitHub Actions, or SSH as before
  - Failed tests block PR merge (branch protection recommended but not required)

- [ ] **P4-PREREQ-2: Graceful shutdown + operational hardening** (`src/proxy.ts`, `src/server.ts`)

  Currently neither process handles SIGTERM. PM2 restart kills in-flight writes.

  **Add to both `proxy.ts` and `server.ts`:**
  ```typescript
  let shuttingDown = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log("info", `${signal} received, flushing write queue...`);
      await writeQueue.flush();
      closeDb();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 15_000);
    });
  }
  ```

  **Also:**
  - Log git push failures in `write-queue.ts` (currently empty catch block)
  - Add `PRAGMA wal_checkpoint(TRUNCATE)` to backup script before tarring grove.db
  - Increase PM2 `kill_timeout` to 15000ms in ecosystem config

  **Files:** `src/proxy.ts`, `src/server.ts`, `src/write-queue.ts`, PM2 ecosystem config

  **Tests:** `test/write-queue.test.ts` — add test that `flush()` completes pending operations before resolving

  **Acceptance criteria:**
  - `pm2 restart grove-server` flushes the write queue before shutting down (verify via log output)
  - Push failures emit structured log entries (not silently swallowed)
  - Backup script produces consistent SQLite snapshots

##### Execution strategy for P4-PREREQ

Single agent handles both tasks (they're small and touch overlapping files). Merge, deploy manually, verify health check. Then launch Phase 4b agents.

---

#### Phase 4b: Ops Dashboard

Implementation splits into two batches: backend API additions (grove repo), then frontend pages (grove-www repo). Backend first because the frontend depends on the endpoints existing.

**Prerequisites:** P4-PREREQ complete (CI live, graceful shutdown in place).

##### Batch 1: Backend API additions (grove repo)

All new admin endpoints go behind `adminAuth()` in `src/proxy.ts`. They use cookie (session) or Bearer auth, same as `/keys`. Agents use worktrees to avoid merge conflicts in proxy.ts.

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

- **Agent A:** P4-API-1 (trail CRUD) — Insert trail routes after the `/v1/stats` handler, before the `// Unknown /v1/ route` fallthrough. Touch `src/trails.ts` (add `updateTrail`). Also update CORS: add `POST, PATCH, DELETE` for `/v1/admin/*`.
- **Agent B:** P4-API-2 (user list + last_login_at) — Insert user route after the `/v1/list` handler, before `/v1/stats`. Touch `src/auth.ts` (fix createSession).
- **Agent C:** P4-API-3 (keys/metrics fixes) — Modify existing `/keys` and `/metrics` handlers in proxy.ts. No new route blocks — editing existing code. Zero overlap with A/B.
- **Agent D:** P4-API-4 (git stats) — Only touches `src/vault-stats.ts`. Zero proxy.ts conflict.

In parallel on the grove-www repo:
- **Agent E:** P4-FE-0 (dashboard layout + all 5 API proxy routes + header link + dashboard overview stub)

Merge order: Agent D first (no conflicts possible), then C (edits existing code), then A, then B. Deploy manually. Then merge Agent E.

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

#### Phase 5c: Tag & Classification Coverage

The trail filtering system works, but only 15% of notes have tags. Rather than adding an LLM judge layer, invest in better classification coverage so the existing deterministic filter catches everything.

- [ ] **P5-TAG-1: Auto-tagging on write** (`src/notes-validate.ts`, `src/server.ts`)

  When `write_note` creates or updates a note, infer tags from the note's path and type if none are provided. Rules:
  - `Journal/*` → add `#journal`
  - `Resources/People/*` → add `#person`
  - `Resources/Concepts/*` → add `#concept`
  - `Resources/Recipes/*` → add `#recipe`
  - `Areas/Health/*` → add `#health`, `#private`
  - `Areas/Finances/*` → add `#finances`, `#private`
  - Notes with `private: true` in frontmatter → add `#private`

  These are defaults — they don't override existing tags, they supplement. The agent writing the note can still set explicit tags.

  **Files:** `src/notes-validate.ts` (add `inferTags(path, frontmatter)` function), `src/server.ts` (call before write)
  **Tests:** `test/notes-validate.test.ts` — verify tag inference for each path pattern
  **Acceptance criteria:**
  - A note written to `Areas/Health/sleep.md` with no tags gets `#health` and `#private` automatically
  - A note written with explicit tags keeps them; inferred tags are added, not replaced
  - Trail filtering accuracy improves (re-run P5-8 eval suite)

- [ ] **P5-TAG-2: Backfill existing notes** (`src/cli.ts`)

  `grove tag-backfill` — reads all notes, applies `inferTags()` to notes with zero tags, writes back via `write_note`. Creates a snapshot before starting.

  **Files:** `src/cli.ts` (new command)
  **Acceptance criteria:**
  - Running `grove tag-backfill` on the vault increases tag coverage from ~15% to >80%
  - Snapshot created before backfill starts
  - Notes that already have tags are not modified
  - Trail filter eval suite (P5-8) still passes with 100% precision

#### Phase 5d: Portal Integration (deferred to Phase 4)

Trail management UI (P4-5), consumer onboarding pages (P4-8), and trail usage views (P4-9) are now part of the Phase 4 Portal. The trail backend is ready — these are frontend tasks.

#### Phase 5 Tests

- Filter accuracy: labeled dataset, precision/recall thresholds
- 404 vs 403: verify hidden notes return 404
- Scope enforcement: trail-scoped key can't access notes outside trail
- Write constraints: trail with read access can't write; trail with write access can't write outside scope
- End-to-end: create trail → generate key → connect as consumer → search → verify filtering
- Tag coverage: after backfill, >80% of notes have at least one tag

---

### CLI Evolution: Agent-Native Interface

**Goal:** The `grove` CLI is the canonical interface for everything. The web dashboard is a view into what the CLI already does. An AI agent with `grove` on PATH can manage the entire system — search, write, inspect, administer — without special integration.

**Prerequisites:** None. Phase A can start immediately. Later phases land alongside their server features.

#### CLI Design Principles

1. **Human first, `--json` for machines.** Default output is terminal-formatted. `--json` emits structured JSON. Auto-detect: if stdout is not a TTY (piped), default to JSON.
2. **Flat top-level, noun+verb for resources.** `grove search`, `grove status` (flat verbs). `grove keys create`, `grove trails list`, `grove users invite` (noun+verb for resource management). No deeper nesting.
3. **Exit codes are a contract.** `0`=success, `1`=client error (bad input, not found), `2`=auth error, `3`=server error (retry). Agents branch on `$?` without parsing stderr.
4. **Every server operation has a CLI command.** If the dashboard can do it, `grove` can do it.
5. **Non-interactive by default.** No prompts. Destructive commands (`rollback`, `keys revoke`, `trails delete`) require `--yes` flag — non-interactive but safe. Without `--yes`, print what would happen and exit 1.
6. **stdout is data, stderr is status.** Data on stdout (human or JSON). Errors and progress on stderr. `grove search --json | jq` works cleanly.

#### JSON Output Contract

**Success envelope:**
```json
{"ok": true, "path": "Resources/Concepts/Taste Graph.md", "content_hash": "a1b2c3d4", ...}
```

**Error envelope (stderr when --json):**
```json
{"ok": false, "error": "not_found", "message": "Note not found: Foo.md"}
```

Error types: `not_found` (exit 1), `invalid_input` (exit 1), `validation_error` (exit 1), `auth_failed` (exit 2), `server_error` (exit 3), `rate_limited` (exit 3, includes `retry_after_ms`), `conflict` (exit 1, includes current `content_hash`).

All dates ISO 8601. All paths vault-relative. `null` for missing fields, never omitted.

#### REST API: Full Read/Write Surface

The REST API is currently read-only (GET endpoints for grove-www SSR). All writes go through MCP, which requires a stateful session handshake (initialize → session ID → tool call). This is painful for CLI, scripts, webhooks, and any HTTP client.

**Architecture:** Extract a shared service layer. Both MCP tools and REST endpoints call the same functions. No HTTP hop between them — both are in-process.

```
REST (stateless HTTP)  ←── CLI, grove-www, scripts, curl, webhooks
       ↓
   Service layer       ←── validation, write queue, git, reindex, trail filtering
       ↑
MCP (stateful session) ←── Claude.ai, Claude Code, MCP clients
```

- [ ] **REST-1: Extract `handleWriteNote` service function** (`src/rest.ts` or `src/vault-write.ts`)

  Move the write logic from server.ts's `write_note` tool handler into a shared function:
  ```typescript
  export async function handleWriteNote(
    notePath: string,
    frontmatter: Record<string, unknown>,
    content: string,
    options: { ifHash?: string; trail?: TrailConfig | null; keyName?: string }
  ): Promise<{ path: string; action: string; content_hash: string; commit: string; url: string }>
  ```

  The MCP `write_note` tool becomes a thin wrapper that parses arguments and calls this function.

  **Files:** `src/rest.ts` (add function), `src/server.ts` (refactor write_note tool to call it)
  **Tests:** Existing write tests must pass. Add `test/rest.test.ts` tests for the extracted function.
  **Acceptance criteria:**
  - MCP `write_note` behavior unchanged
  - `handleWriteNote` is independently callable with the same validation, write queue, git commit, and reindex behavior

- [ ] **REST-2: `PUT /v1/notes/:path` write endpoint** (`src/proxy.ts`)

  ```
  PUT /v1/notes/Resources/Concepts/context-engineering.md
  Authorization: Bearer grove_live_xxx
  If-Match: "abc123"  (optional — optimistic concurrency, maps to if_hash)
  Content-Type: application/json

  {
    "frontmatter": { "type": "concept", "tags": ["ai"] },
    "content": "# Context Engineering\n\nThe art of..."
  }

  → 201 Created (new) or 200 OK (update)
  {
    "path": "Resources/Concepts/context-engineering.md",
    "action": "create",
    "content_hash": "def456",
    "commit": "abc789",
    "url": "https://grove.md/Resources/Concepts/context-engineering"
  }

  → 409 Conflict (hash mismatch)
  → 400 Bad Request (validation failure)
  → 403 Forbidden (trail scope violation on writes — 403 not 404, client needs to know why)
  ```

  PUT because the client specifies the resource path. `If-Match` header is standard HTTP optimistic concurrency.

  Wire through auth, trail resolution, rate limiting (same as MCP path). Call `handleWriteNote`.

  **Files:** `src/proxy.ts` (new route), `src/rest.ts` (already has handleWriteNote from REST-1)
  **Tests:** `test/rest.test.ts` — PUT creates note, PUT with If-Match detects conflict, validation errors return 400
  **Acceptance criteria:**
  - `curl -X PUT https://api.grove.md/v1/notes/path.md -H "Authorization: Bearer xxx" -d '{"frontmatter":{...},"content":"..."}' ` creates a note
  - Trail-scoped keys can only write to allowed paths
  - Write queue serialization preserved (concurrent PUTs don't corrupt)
  - If-Match with wrong hash returns 409 with current hash in response

- [ ] **REST-3: `GET /v1/status/:mode` endpoints** (`src/proxy.ts`)

  Expose all vault_status modes via REST:
  ```
  GET /v1/status/health
  GET /v1/status/history?since=1+week+ago
  GET /v1/status/diagnostics
  GET /v1/status/graph
  GET /v1/status/digest
  ```

  Current `/v1/stats` stays for backward compat. These are the full vault_status surface.

  **Files:** `src/proxy.ts` (new routes), `src/rest.ts` (reuse existing vault-status functions)

- [ ] **REST-4: Migrate CLI from MCP to REST** (`src/cli.ts`)

  Replace the MCP handshake (`initialize` → session → `callTool`) with direct HTTP calls:
  - `grove search "X"` → `GET /v1/search?q=X&limit=10`
  - `grove read "X"` → `GET /v1/notes/X`
  - `grove list "X"` → `GET /v1/list?prefix=X`
  - `grove write "path"` → `PUT /v1/notes/path`
  - `grove status` → `GET /v1/status/health`
  - `grove history` → `GET /v1/status/history`
  - `grove diagnostics` → `GET /v1/status/diagnostics`

  Delete: `initialize()`, `mcpRequest()`, `callTool()`, session ID tracking. Replace with a single `httpRequest(method, path, body?)` helper.

  Each CLI command becomes a single HTTP request instead of a 3-step MCP handshake. Latency drops significantly.

  **Files:** `src/cli.ts` (major refactor — delete MCP code, add HTTP calls)
  **Tests:** `test/cli.test.ts` — mock HTTP responses instead of MCP responses
  **Acceptance criteria:**
  - All existing CLI commands work identically
  - No MCP session initialization in CLI code
  - `grove write path.md --content "text"` uses `PUT /v1/notes/path.md`
  - CLI works from any machine pointing at api.grove.md (no local dependencies for vault ops)

##### REST Execution Strategy

- **Agent A:** REST-1 + REST-2 (service extraction + PUT endpoint) — tightly coupled, same refactor
- **Agent B:** REST-3 (status endpoints) — independent of Agent A

Merge A first, then B. Then REST-4 (CLI migration) as a follow-up — it depends on the endpoints existing.

REST-4 can be combined with CLI-A1 (--json) since both refactor the CLI command functions. The agent doing CLI-A would handle both the output format change and the MCP→REST migration in one pass.

#### CLI-A: Foundation (before Phase 4b)

These make the CLI agent-usable. Do first. REST-1 through REST-3 should land before or alongside CLI-A (CLI-A4's migration depends on REST endpoints existing).

- [ ] **CLI-A1: `--json` global flag** (`src/cli.ts`)

  Add `--json` to `parseArgs` as a top-level boolean. Each command function returns a result object instead of calling `console.log`. The dispatcher handles formatting: if `--json`, emit the result as JSON to stdout; otherwise, call the existing human formatter.

  Auto-detect non-TTY: `if (!process.stdout.isTTY) flags.json = true`.

  After REST-4 (CLI migration to REST), command functions receive clean JSON from HTTP responses. The `--json` implementation wraps the response data in the `{"ok": true, ...}` envelope. If REST-4 hasn't landed yet, the MCP text responses need parsing first — but the refactor is cleaner if done together.

  **Files:** `src/cli.ts` (modify parseArgs, refactor each command to return data)
  **Tests:** `test/cli.test.ts` — verify JSON output shape for each command, verify non-TTY detection
  **Acceptance criteria:**
  - `grove search "test" --json` emits valid JSON with `ok`, `results`, `count` fields
  - `grove read "path" --json` emits valid JSON with `path`, `frontmatter`, `content`, `content_hash`
  - `grove search "test" | cat` emits JSON (non-TTY auto-detection)
  - Human-formatted output unchanged when no `--json` and stdout is TTY

- [ ] **CLI-A2: Exit codes + structured errors**

  Replace all `process.exit(1)` calls with thrown `CliError`:
  ```typescript
  class CliError extends Error {
    constructor(public code: string, message: string, public exitCode: number = 1) {
      super(message);
    }
  }
  ```

  Dispatcher catches `CliError`, formats per output mode, exits with correct code. Unhandled errors become exit 3 with code `server_error`.

  **Files:** `src/cli.ts`
  **Tests:** `test/cli.test.ts` — verify exit codes: not-found=1, bad auth=2, server down=3
  **Acceptance criteria:**
  - `grove read "nonexistent" --json` exits 1 with `{"ok": false, "error": "not_found", ...}` on stderr
  - `grove search "test"` with invalid token exits 2
  - Connection refused exits 3

- [ ] **CLI-A3: `--content` flag on write**

  `grove write path.md --type concept --content "The actual content"` — alternative to stdin. If neither stdin nor `--content` is provided and stdin is a TTY, error immediately with usage hint instead of hanging.

  **Files:** `src/cli.ts` (modify cmdWrite)
  **Acceptance criteria:**
  - `grove write path.md --content "text" --type concept` creates the note
  - `grove write path.md --type concept` with no pipe and TTY stdin exits 1 with "Provide content via --content flag or pipe to stdin"

- [ ] **CLI-A4: `grove init`**

  Guided non-interactive config setup:
  `grove init --server https://api.grove.md --token grove_live_xxx`

  Validates by calling `/health` on the server. Writes `~/.grove/cli.json`. Also support `GROVE_SERVER` and `GROVE_TOKEN` env vars as overrides (env > config file).

  **Files:** `src/cli.ts`
  **Acceptance criteria:**
  - `grove init --server X --token Y` creates config file and prints "Connected to X as <key-name>"
  - `GROVE_TOKEN=xxx grove search "test"` works without a config file

- [ ] **CLI-A5: Promote `graph` and `digest` to top-level commands**

  `grove graph` → calls `vault_status(mode: "graph")`. Shows clusters, hubs, centrality.
  `grove digest` → calls `vault_status(mode: "digest")`. Shows lifecycle stages.

  Currently hidden as modes inside `grove status`. Not discoverable.

  **Files:** `src/cli.ts` (add two case entries, add formatters)
  **Acceptance criteria:**
  - `grove graph --json` returns `{ nodes, edges, clusters, top_hubs }`
  - `grove digest --json` returns `{ lifecycle: { seeds, sprouts, ... }, velocity_7d }`

- [ ] **CLI-A6: `grove health` + `grove metrics`**

  `grove health` — HTTP GET `/health`, formats component status.
  `grove metrics` — HTTP GET `/metrics`, formats request counts and latency.

  **Files:** `src/cli.ts` (add commands, HTTP calls matching keys pattern)
  **Acceptance criteria:**
  - `grove health --json` returns `{ ok: true, components: { proxy, server, qmd, embeddings } }`
  - `grove metrics --json` returns request counts, p50/p95/p99, error rates

- [ ] **CLI-A7: Help text with output schemas**

  Each command's `--help` shows: usage, examples, flags, JSON output schema, exit codes. Top-level `grove` (no args) shows grouped command listing with one-line descriptions.

  ```
  grove search <query> [-n N] [--json] [--paths]
    Search notes. Returns ranked results with snippets.
    JSON: {ok, results: [{path, title, score, snippet}], count}
    Exit: 0=found, 1=bad input, 2=auth, 3=server
  ```

  **Files:** `src/cli.ts` (add HELP records per command)

#### CLI-B: Consistency + Composability (after P4-API-1)

- [ ] **CLI-B1: Move trails to HTTP**

  Replace direct SQLite imports (`loadTrails`, `createTrail`, etc.) with HTTP calls to `POST /v1/admin/trails` (matching the `/keys` pattern). Enables running `grove trails` from any machine, not just the server.

  **Files:** `src/cli.ts` (refactor cmdTrails* functions)
  **Acceptance criteria:**
  - `grove trails list` works from a laptop pointing at api.grove.md
  - All trail subcommands (list, create, disable, delete) use HTTP
  - `grove trails delete <id>` requires `--yes` flag

- [ ] **CLI-B2: `--paths` flag on search/list**

  Emit one path per line, nothing else. For `xargs` composability.

  ```bash
  grove search "machine learning" --paths | xargs -I{} grove read "{}" --json
  ```

  **Files:** `src/cli.ts`

- [ ] **CLI-B3: `--if-hash` on write**

  Expose the server's content hash checking for safe read-modify-write loops:

  ```bash
  data=$(grove read "Taste Graph" --json)
  hash=$(echo "$data" | jq -r '.content_hash')
  echo "updated content" | grove write "Resources/Concepts/Taste Graph.md" --if-hash "$hash"
  # Exits 1 with error "conflict" if hash doesn't match
  ```

  **Files:** `src/cli.ts` (pass If-Match header on PUT /v1/notes/)

- [ ] **CLI-B4: `grove whoami`**

  Call server, print key name, scopes, vault. Quick identity check.

  **Files:** `src/cli.ts`

#### CLI-C: Module Extraction (when cli.ts exceeds ~1200 LOC)

Split into `src/cli/` directory:
```
src/cli/
  index.ts          # parseArgs, dispatch, global flags, main()
  output.ts         # format(), error(), JSON envelope, human formatters
  client.ts         # Config, loadConfig, httpGet, httpPut, httpPost
  commands/
    search.ts       # cmdSearch
    read.ts         # cmdRead, cmdGet
    write.ts        # cmdWrite
    inspect.ts      # cmdStatus, cmdHistory, cmdDiagnostics, cmdGraph, cmdDigest
    keys.ts         # cmdKeys*
    trails.ts       # cmdTrails*
    admin.ts        # cmdHealth, cmdMetrics, cmdWhoami, cmdInit
    local.ts        # cmdSnapshot, cmdRollback, cmdLint, cmdSync
```

Each command function has signature `(client: Client, positional: string, flags: Flags) => Promise<CommandResult>`. Never calls `console.log` or `process.exit`. The dispatcher handles all I/O.

This is a refactor, not a feature. Do it when adding Phase D commands makes the single file unwieldy.

#### CLI-D: Feature Commands (as server features land)

| Command | Server dependency | Phase |
|---------|-------------------|-------|
| `grove users list` | P4-API-2 (user list endpoint) | Phase 9a |
| `grove users invite <email> --trail <id> --role viewer` | P9-2 (invite flow) | Phase 9a |
| `grove share <path> [--ttl 7d]` | P9-7 (share-a-note) | Phase 9b |
| `grove tag-backfill` | P5-TAG-2 (tag inference) | P5-TAG |
| `grove ingest <dir>` | P7-7 (ingest command) | Phase 7b |
| `grove discovery` | P7-5 (discovery digest) | Phase 7a |
| `grove write --batch` | Needs server batch write API (not yet spec'd) | Phase 7+ |

`grove write --batch` reads JSONL from stdin, each line is `{"path", "type", "tags", "content"}`. Requires a server-side batch write endpoint (one git commit for N notes). Spec the server endpoint when the need materializes (harvesting or ingestion workflows that write 10+ notes).

#### CLI Execution Strategy

**CLI-A (7 tasks, 2 parallel agents):**
- **Agent A:** CLI-A1 + CLI-A2 (--json + exit codes) — these are tightly coupled, same refactor
- **Agent B:** CLI-A3 + CLI-A4 + CLI-A5 + CLI-A6 + CLI-A7 (new flags, new commands, help) — independent of A's refactor, adds to existing command structure

Merge Agent A first (structural change to how commands return data). Then Agent B (adds features on top).

**CLI-B (4 tasks, after CLI-A + P4-API-1 merged):** Single agent, sequential. Each task is small.

**CLI-C:** Single agent when triggered by LOC threshold.

**CLI-D:** One task per feature, lands with its server phase.

#### Complete Command Reference (after all phases)

**Vault operations:**
| Command | Description |
|---------|-------------|
| `grove search <query>` | Hybrid search (BM25 + vector) |
| `grove read <path>` | Read a note by path or title |
| `grove write <path>` | Create/update a note |
| `grove list <pattern>` | List notes matching a glob |

**Vault introspection:**
| Command | Description |
|---------|-------------|
| `grove status` | Vault health summary |
| `grove history` | Recent git changes |
| `grove diagnostics` | Orphans, broken links, missing frontmatter |
| `grove graph` | Knowledge graph: clusters, hubs, centrality |
| `grove digest` | Lifecycle: seeds, sprouts, growing, mature |
| `grove discovery` | Discovery loop: recent extractions, new concepts |

**Administration:**
| Command | Description |
|---------|-------------|
| `grove keys list\|create\|revoke` | API key management |
| `grove trails list\|create\|disable\|delete` | Trail management |
| `grove users list\|invite` | User management |
| `grove health` | Server component health |
| `grove metrics` | Request counts, latency, error rates |
| `grove share <path>` | Generate expiring share link |
| `grove whoami` | Current identity + scopes |
| `grove init` | Config setup |

**Local operations:**
| Command | Description |
|---------|-------------|
| `grove snapshot [message]` | Create vault snapshot (git tag) |
| `grove rollback <tag>` | Restore vault to snapshot (requires `--yes`) |
| `grove lint <dir>` | Normalize YAML frontmatter |
| `grove sync <dir>` | Sync archive sources |
| `grove tag-backfill` | Apply inferred tags to untagged notes |
| `grove ingest <dir>` | Bulk import markdown files |

**Global flags:** `--json`, `--quiet`, `--verbose`, `--yes`, `--help`

---

### ~~Phase 6: LLM Judge~~ — REMOVED FROM SCOPE

Tag/type/path prefilter handles trail filtering. The right investment is better tag coverage across the vault, not an LLM layer. See P5-TAG below.

---

### Phase 7: Discovery & Onboarding

**Goal:** Knowledge grows autonomously. New content integrates without manual invocation.

**Prerequisites:** Phases 2-5 stable. CI/CD live (P4-PREREQ-2).

**Key design decision (changed from original plan):** Concept extraction uses Claude API via MCP tool calls (not local Ollama). The discovery loop runs as a background Node.js process that calls Grove's own MCP tools — it's an agent that uses the same API as Claude.ai. This means no GPU, no Ollama, no model management. The VPS stays lean.

#### Phase 7a: Background Discovery

- [ ] **P7-1: Discovery loop skeleton** (`src/discovery.ts`, `src/discovery-worker.ts`)

  Background process managed by PM2. Watches for vault changes via two triggers:
  1. **Git hook:** `post-commit` hook in the vault repo calls `curl http://localhost:8190/internal/discovery-trigger?path=<changed-file>`
  2. **Write queue hook:** `write-queue.ts` emits an event after successful write+commit

  The loop maintains a SQLite queue table (`discovery_queue`) with columns: `path`, `trigger` (commit|write), `queued_at`, `processed_at`, `status`.

  **Files:** `src/discovery.ts` (main loop — dequeues, dispatches to extractors), `src/discovery-worker.ts` (PM2 entry point), `src/db.ts` (add `discovery_queue` table to schema)

  **Acceptance criteria:**
  - `pm2 start discovery-worker` runs without errors
  - Writing a note via `write_note` adds an entry to `discovery_queue`
  - The loop dequeues and logs "processing <path>" for each entry
  - Processed entries are marked `status = 'done'` with timestamp
  - The loop handles errors gracefully — a failed note doesn't block the queue

- [ ] **P7-2: Concept extraction via Claude API** (`src/discovery-extract.ts`)

  For each changed note, call Claude API (claude-haiku-4-5 for cost efficiency) with:
  - The note's full content
  - The vault's entity vocabulary (from `list_notes` with type filter)
  - A structured output schema requesting: extracted entities (name, type, confidence), suggested wikilinks, new concept notes to create

  ```typescript
  interface ExtractionResult {
    entities: { name: string; type: "person" | "concept" | "project" | "company"; confidence: number; existing_path?: string }[];
    suggested_links: { from_text: string; to_path: string }[];
    new_notes: { path: string; type: string; tags: string[]; content: string }[];
  }
  ```

  Match extracted entities against existing vault notes (case-insensitive name + alias matching via `list_notes`). Only create new concept notes for entities with confidence > 0.8 that don't match existing notes.

  **Files:** `src/discovery-extract.ts` (extraction logic), `src/discovery.ts` (integrate extractor into loop)
  **Dependencies:** `@anthropic-ai/sdk` (add to package.json)
  **Env var:** `ANTHROPIC_API_KEY` (add to env var docs)

  **Tests:** `test/discovery-extract.test.ts` — mock Claude API response, verify entity matching, verify dedup against existing notes
  **Acceptance criteria:**
  - Given a journal entry mentioning "John Smith" and an existing `Resources/People/John Smith.md`, extraction matches (doesn't create duplicate)
  - Given a note about "reinforcement learning" with no existing concept note, extraction suggests creating `Resources/Concepts/Reinforcement Learning.md`
  - Extraction result includes confidence scores; low-confidence entities are logged but not acted on

- [ ] **P7-3: Wikilink wiring** (`src/discovery-link.ts`)

  After extraction, wire wikilinks into the source note. For each `suggested_links` entry: find the `from_text` in the note content, wrap it in `[[to_path|from_text]]`. Write the updated note via `write_note` (through the write queue, not direct filesystem).

  Also create any `new_notes` from the extraction result via `write_note`.

  **Files:** `src/discovery-link.ts` (link insertion logic), `src/discovery.ts` (integrate linker into loop after extraction)
  **Tests:** `test/discovery-link.test.ts` — verify link insertion preserves existing content, handles edge cases (text appears multiple times, text is already linked)
  **Acceptance criteria:**
  - A note mentioning "machine learning" gets `[[Resources/Concepts/Machine Learning|machine learning]]` inserted
  - Already-linked text is not double-linked
  - Link insertion doesn't corrupt frontmatter
  - New concept notes are created with proper frontmatter (type, tags, aliases)

- [ ] **P7-4: Semantic neighbor surfacing** (`src/discovery-neighbors.ts`)

  After processing a note, find embedding-similar notes not already linked. Use `query` tool with `vec` sub-query type, filter out notes that are already wikilinked from/to the source note. Store surprising connections in a `discovery_results` table.

  ```sql
  CREATE TABLE IF NOT EXISTS discovery_results (
    id TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,
    target_path TEXT NOT NULL,
    similarity REAL NOT NULL,
    relationship TEXT, -- "semantic neighbor", "potential duplicate", etc.
    created_at TEXT NOT NULL,
    dismissed_at TEXT -- user can dismiss suggestions
  );
  ```

  **Files:** `src/discovery-neighbors.ts`, `src/db.ts` (add table)
  **Acceptance criteria:**
  - Processing a note about "transformer architecture" surfaces similar notes about "attention mechanisms"
  - Already-linked notes are excluded from results
  - Results are stored with similarity scores for later review

- [ ] **P7-5: Discovery digest** (extend `vault_status` in `src/server.ts`)

  New `vault_status` mode: `discovery`. Returns:
  ```typescript
  {
    recent_extractions: { path: string; entities_found: number; links_wired: number; processed_at: string }[];
    new_concepts_created: { path: string; created_at: string; triggered_by: string }[];
    surprising_connections: { source: string; target: string; similarity: number }[];
    queue_depth: number;
    last_processed_at: string;
  }
  ```

  Data sourced from `discovery_queue` and `discovery_results` tables.

  **Files:** `src/server.ts` (add discovery mode to vault_status handler), `src/db.ts` (query functions)
  **Acceptance criteria:**
  - `vault_status(mode: "discovery")` returns the digest
  - Empty state (no discovery results yet) returns zeroed fields, not errors

- [ ] **P7-6: Bookmark integration** (`src/discovery-bookmarks.ts`)

  Cron job (every 30 min) checks for new X bookmarks via `bird` CLI. For each new bookmark:
  1. Fetch the URL content (or use `bird` metadata)
  2. Create a Source note in `Sources/` with proper frontmatter
  3. Enqueue the new note in `discovery_queue` for concept extraction

  **Files:** `src/discovery-bookmarks.ts` (bookmark sync), PM2 cron config or `node-cron` in the worker
  **Acceptance criteria:**
  - New X bookmarks appear as Source notes in the vault
  - Each bookmark note gets queued for discovery processing
  - Already-synced bookmarks are not duplicated (dedup via URL)

#### Phase 7b: Bulk Onboarding

- [ ] **P7-7: Ingest command** (extend `src/cli.ts`)

  `grove ingest <dir>` — reads a directory of .md files, parses frontmatter/content, deduplicates against existing vault (by title + content hash), writes new notes via `write_note` MCP tool call. Creates a snapshot before starting (`grove snapshot`).

  **Files:** `src/cli.ts` (add `ingest` command)
  **Acceptance criteria:**
  - `grove ingest ./import/` creates notes from all .md files in the directory
  - Duplicate detection prevents re-importing existing notes
  - Progress output: "Imported 42/50 notes (8 skipped as duplicates)"
  - Snapshot created before ingest starts

- [ ] **P7-8: Post-ingest concept bootstrap**

  After `grove ingest`, enqueue all newly created notes in `discovery_queue` with `trigger = 'ingest'`. The discovery loop processes them, extracting concepts and wiring links. This is the cold start path for new users or content dumps.

  **Files:** `src/cli.ts` (extend ingest to enqueue), `src/discovery.ts` (handle ingest trigger)
  **Acceptance criteria:**
  - After ingesting 50 notes, all 50 appear in discovery queue
  - Discovery loop processes them and creates concept notes
  - Graph connectivity increases (measurable via `vault_status(mode: "graph")`)

#### Phase 7 Execution Strategy

**Batch 1 (2 parallel agents):**
- **Agent A:** P7-1 (discovery loop skeleton) — creates `src/discovery.ts`, `src/discovery-worker.ts`, adds queue table to `db.ts`
- **Agent B:** P7-7 (ingest command) — extends `src/cli.ts` only, no overlap with Agent A

**Batch 2 (2 parallel agents, after Batch 1 merged):**
- **Agent C:** P7-2 + P7-3 (concept extraction + wikilink wiring) — creates `src/discovery-extract.ts` and `src/discovery-link.ts`, integrates into discovery loop
- **Agent D:** P7-4 (semantic neighbors) — creates `src/discovery-neighbors.ts`, adds table to `db.ts` (different table than Batch 1, safe merge)

**Batch 3 (2 parallel agents, after Batch 2 merged):**
- **Agent E:** P7-5 (discovery digest) — extends `vault_status` in `server.ts`
- **Agent F:** P7-6 + P7-8 (bookmarks + post-ingest bootstrap) — creates `src/discovery-bookmarks.ts`, extends cli.ts ingest

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

**Prerequisites:** P4-PREREQ complete (CI/CD, route extraction). Phase B (magic link auth) complete.

**Context:** Phase B established the foundation — users exist in the database, magic links create identity, sessions persist. But today there's exactly one user (`user_00000000`), everyone shares the same vault, and "collaboration" means handing someone a trail-scoped read-only key. This phase adds user roles, invitations, and trail sharing UX.

**Scope decision:** Annotations (comments, reactions) are deferred. Build them only after there's evidence of collaborative usage (at least 3 active non-owner users). Don't build social features for a solo product.

#### Phase 9a: User Management

- [ ] **P9-1: User roles** (`src/db.ts`, `src/users.ts`, `src/proxy.ts`)

  Add `role` column to users table: `owner` (full access), `member` (trail-scoped read+write), `viewer` (trail-scoped read-only).

  **Schema migration in `src/db.ts`:**
  ```sql
  ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer';
  UPDATE users SET role = 'owner' WHERE id = 'user_00000000';
  ```

  **`src/users.ts` changes:** Add `getUserRole(userId)`, update `createUser()` to accept optional `role` parameter.

  **`src/proxy.ts` changes:** `adminAuth()` middleware checks `role = 'owner'` for admin endpoints. Non-owners get 403.

  **Files:** `src/db.ts`, `src/users.ts`, `src/proxy.ts`
  **Tests:** `test/users.test.ts` — create user with role, verify role-based auth check
  **Acceptance criteria:**
  - Existing user `user_00000000` gets `role = 'owner'` on migration
  - New users default to `viewer`
  - Non-owner hitting `/keys` or `/v1/admin/*` gets 403
  - Owner access unchanged

- [ ] **P9-2: Invite flow** (`src/invite.ts`, `src/proxy.ts`, `src/cli.ts`)

  **CLI:** `grove invite <email> --trail <trail-id> --role viewer`
  **API:** `POST /v1/admin/invite` with `{ email, trail_id, role }`

  Implementation:
  1. Create user record if no user with that email exists (`createUser(email, role)`)
  2. Create trail grant in `trail_grants` table (link user to trail)
  3. Send magic link email with welcome message (extend `sendMagicLinkEmail` with optional `welcome: true` flag)
  4. On first login via magic link, auto-provision scoped API key (reuse existing auth code exchange flow)

  **Files:** `src/invite.ts` (invite logic), `src/proxy.ts` (new route), `src/cli.ts` (new command), `src/email.ts` (welcome variant)
  **Tests:** `test/invite.test.ts` — invite creates user + trail grant, duplicate invite is idempotent, invalid trail ID returns 404
  **Acceptance criteria:**
  - `grove invite alice@example.com --trail trail_abc123 --role viewer` succeeds
  - Alice receives an email with a magic link
  - After clicking the link, Alice has a trail-scoped API key
  - Re-inviting the same email is idempotent (no duplicate user)

- [ ] **P9-3: User-scoped keys** (`src/keys.ts`, `src/proxy.ts`)

  Today all keys are owned by `user_00000000`. After this task, keys are scoped to their creating user.

  **`src/keys.ts` changes:** `createKey()` accepts `user_id` parameter. `loadKeys()` accepts optional `user_id` filter.

  **`src/proxy.ts` changes:** `/keys` list action filters by current user's ID (owner sees all, others see only their own). Create action sets `user_id` to current user.

  **Migration:** Existing keys get `user_id = 'user_00000000'` (already the case in schema).

  **Files:** `src/keys.ts`, `src/proxy.ts`
  **Tests:** `test/keys.test.ts` — key created with user_id, filtered list returns only user's keys
  **Acceptance criteria:**
  - Owner can see and manage all keys
  - Viewer can only see their own auto-provisioned key
  - Creating a key records the user who created it

- [ ] **P9-4: User management UI** (grove-www repo: `src/app/dashboard/users/page.tsx`)

  Owner-only page in the dashboard. Requires Phase 4b dashboard layout (P4-FE-0) to be merged.

  **Layout:**
  - Header: "Users" heading + "Invite" button
  - Table: Email, Role (badge), Last Login (relative time), Trails (comma-separated names), Keys (count), Actions
  - Invite flow: inline form — email input + trail dropdown + role radio (viewer/member) + send button
  - Revoke: "Remove" button per user → confirm → delete user's keys and sessions → remove from list

  **Files:** `src/app/dashboard/users/page.tsx`, `src/components/user-table.tsx` (client component)
  **Acceptance criteria:**
  - Lists all users with metadata
  - Invite flow sends magic link and user appears in list
  - Revoking a user immediately invalidates their keys and sessions
  - Non-owner accessing this page gets redirected

#### Phase 9b: Trail Sharing UX

- [ ] **P9-5: Shareable trail links** (grove-www repo: `src/app/trails/[slug]/page.tsx`)

  Public onboarding page per trail: `grove.md/trails/<trail-slug>`. Shows trail name, description, note count, and a "Sign in to access" button. No login required to see the page — but reading notes requires auth.

  **Backend (grove repo):** Add `GET /v1/trails/:id/info` to `src/proxy.ts` — unauthenticated endpoint returning `{ name, description, note_count, created_at }`. Count notes matching trail filters via a quick scan.

  **Frontend:** Centered card layout (same style as login page). Trail name (serif heading), description, note count, two access methods:
  1. "Sign in to browse" button → `/login?trail=<id>`
  2. "Connect via MCP" section with copy-paste config block

  **Files:** `src/proxy.ts` (grove repo — new endpoint), `src/app/trails/[slug]/page.tsx` (grove-www)
  **Acceptance criteria:**
  - Page loads without auth — public access
  - Shows trail name, description, note count
  - MCP config block is copy-pasteable
  - Non-existent trail ID → 404 page

- [ ] **P9-6: Trail-scoped grove.md experience** (grove-www repo)

  When a viewer/member signs in via a trail link, their `grove.md` session is scoped to that trail. They see the trail name in the header, search only returns trail-visible notes, and navigation is limited to trail-allowed paths.

  **Implementation:** The auto-provisioned API key has trail-scoped access. The existing server-side filtering handles the rest — no frontend logic needed beyond showing the trail context in the header.

  **Files:** `src/components/header.tsx` (show trail name for scoped sessions), `src/app/api/auth/callback/route.ts` (pass trail context through login flow)
  **Acceptance criteria:**
  - Viewer sees trail name in header after signing in via trail link
  - Search returns only trail-scoped results
  - Navigation shows only trail-allowed paths
  - Owner view is unchanged

- [ ] **P9-7: Share-a-note links** (`src/proxy.ts`, grove-www: `src/app/s/[id]/page.tsx`)

  Owner generates a shareable link to a specific note: `grove.md/s/<short-id>`. The link creates a temporary trail scoped to that single note and its depth-1 inbound backlinks (notes that wikilink TO the shared note — outbound links excluded to prevent leaking sensitive content). Expires after configurable TTL (default 7 days).

  **Schema addition in `src/db.ts`:**
  ```sql
  CREATE TABLE IF NOT EXISTS shared_links (
    id TEXT PRIMARY KEY,
    note_path TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    max_views INTEGER DEFAULT 100,
    view_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
  ```

  **API:** `POST /v1/admin/share` with `{ note_path, ttl_days?: number, max_views?: number }` → `{ id, url, expires_at }`

  **Files:** `src/db.ts` (table), `src/proxy.ts` (create endpoint), `src/proxy.ts` (resolve share link → micro-trail), grove-www `src/app/s/[id]/page.tsx`
  **Acceptance criteria:**
  - Owner creates share link → gets URL
  - Recipient opens URL, signs in with email, sees the note + inbound backlinks
  - Outbound links from the shared note are NOT visible
  - Link expires after TTL — returns "This link has expired"
  - View count increments; link disabled after max_views reached

#### Phase 9 Design Decisions

| Decision | Chosen | Why |
|----------|--------|-----|
| User creation | Invite-only (owner sends magic link) | No public signup. Grove is private-first. Access is granted, not requested. |
| Viewer experience | Trail-scoped grove.md, same codebase | No separate app for viewers. The API key's trail scope does the filtering. |
| Share links | Micro-trails with depth-1 inbound backlinks | Even shared notes require email auth. No anonymous access. Outbound links excluded to prevent leaking sensitive content. |
| Roles | owner/member/viewer | Minimal. Don't add "editor", "admin", "moderator" until there's a real need. |
| Annotations | Out of scope | Build if/when collaborative usage patterns emerge. Not planning for it now. |

#### Phase 9 Execution Strategy

**Batch 1 (3 parallel agents, grove repo):**
- **Agent A:** P9-1 (user roles) — touches `src/db.ts` (ALTER TABLE), `src/users.ts`, `src/proxy.ts` (adminAuth check)
- **Agent B:** P9-2 (invite flow) — creates `src/invite.ts`, extends `src/proxy.ts` (new route), extends `src/cli.ts`, `src/email.ts`. Potential conflict with Agent A on `routes/admin.ts` — Agent B should create the route in a separate function that Agent A's adminAuth check will guard.
- **Agent C:** P9-3 (user-scoped keys) — touches `src/keys.ts`, `src/proxy.ts` (existing /keys handler). Minimal overlap with A/B.

Merge order: Agent A first (adminAuth changes are foundational), then B+C.

**Batch 2 (2 parallel agents, after Batch 1 merged):**
- **Agent D:** P9-4 (user management UI, grove-www) — needs dashboard layout from Phase 4b
- **Agent E:** P9-5 + P9-6 (trail sharing pages, grove-www) — separate routes from Agent D

**Batch 3 (1 agent, after Batch 2 merged):**
- **Agent F:** P9-7 (share-a-note) — touches both repos (share table + API in grove, page in grove-www)

#### Phase 9 Success Criteria

- Owner invites a collaborator by email → they receive a magic link → click it → land on grove.md seeing only their trail's notes
- Viewer searches and only gets trail-scoped results (no leaks)
- Share-a-note link works: recipient opens it, signs in, sees the note + inbound backlinks only
- Share link expires after TTL — accessing it returns "This link has expired"
- Owner can see all users, their roles, last login, and assigned trails in the management UI
- Revoking a user's access immediately invalidates their keys and sessions
- Non-owner hitting admin endpoints gets 403

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
| Trail boundaries | Tag/type/path prefilter only | + LLM judge, semantic-only | Prefilter is fast, deterministic, covers 90%+. LLM judge cancelled — solution looking for a problem. If filtering proves too coarse, use Claude API as rerank signal. |
| Trail filter location | Server layer (`server.ts`) | Proxy layer | Server has frontmatter, tags, search pipeline. Proxy only resolves trail context. |
| Hidden note response | 404 (not 403) | 403 Forbidden | 403 leaks that the note exists. 404 is indistinguishable from non-existent. |
| Encryption at rest | EBS encryption (AWS-managed) | LUKS, git-crypt, defer | LUKS is wrong for AWS — volume is decrypted at runtime. EBS encryption is free, automatic, protects snapshots. |
| Monitoring | BetterStack | Grafana Cloud, custom-built | Free tier covers this scale. Uptime + logs + alerting in one product. |
| Metrics format | JSON `/metrics` endpoint | Prometheus exposition | No scraper needed at this scale. Internal counters serve the dashboard directly. |
| Dashboard data source | Internal counters | BetterStack API | Avoids external dependency for own dashboard. Counters reset on restart (fine). Daily rollups to SQLite for history. |
| Admin auth | Magic link + API key + persistent SQLite sessions | GitHub OAuth, passkey, JWT | Magic links are frictionless and establish email identity. Sessions survive restarts. Foundation for multi-user. |
| Cross-domain auth | Auth code exchange (one-time code redirect) | Shared cookie domain, iframe, proxy all requests | Auth codes are single-use, 60s TTL, don't require same domain. Frontend keeps working with Bearer auth unchanged. |
| Email delivery | Resend API (one fetch call) | SES, Mailgun, custom SMTP | Minimal integration — one fetch, no SDK. Dev mode falls back to console.log. |
| Annotations | Out of scope | Inline in notes, separate annotation files | Not building social features until collaborative usage patterns emerge. |
| User creation | Invite-only (owner sends magic link) | Public signup, OAuth providers | Grove is private-first. Access is granted, not requested. |
| LLM judge | Cancelled | Ship with trails, rule-based only | Prefilter covers 90%+. LLM adds latency, fragility, and infra (Ollama doesn't fit on t3.medium). If needed later, use Claude API as rerank signal — no local model. |
| Discovery extraction | Claude API (claude-haiku-4-5) | Local LLM (Ollama) | VPS is t3.medium (4GB RAM) — Ollama + Qwen needs 3-4GB minimum. Claude API is simpler, no GPU, no model management, pay-per-use. |
| CI/CD | GitHub Actions CI + manual deploy trigger | Manual SSH deploy | CI gives agents automated feedback on PRs. Deploy stays manual — the VPS runs a live personal knowledge API, so deploys are a human decision. |
| CLI as canonical interface | CLI-first, dashboard reads from CLI | Dashboard-first, CLI as secondary | Agents need full control via CLI. The dashboard is a view, not the control plane. Every server capability gets a CLI command. |
| CLI output | Human default, `--json` for machines, auto-detect non-TTY | JSON-only, human-only | Humans and agents use the same tool. Auto-detection means agents get JSON without asking when piped. |
| CLI taxonomy | Flat verbs + noun-verb for resources | Nested namespaces (grove admin keys list) | Flat is fewer keystrokes. Noun-verb (grove keys create) is natural for CRUD on resources. No deeper nesting. |
| Destructive CLI ops | Require `--yes` flag, no interactive prompts | Interactive confirmation | Agents can't answer prompts. `--yes` is scriptable and explicit. Without it, command shows what would happen and exits 1. |
| CLI communication | All ops through REST HTTP | MCP JSON-RPC, local SQLite | MCP requires stateful session handshake for every CLI invocation. REST is single-request. CLI migrates from MCP to REST. Local ops (lint, snapshot) stay local. |
| REST API scope | Full read/write (PUT /v1/notes/) | Read-only (GET only) | Writes through MCP require session dance. REST PUT is a single HTTP call. Both call the same service layer — no protocol hop. |
| REST write method | PUT (client specifies path) | POST (server generates ID) | Notes have user-specified paths. PUT is textbook REST for this. If-Match header for optimistic concurrency. |
| Graceful shutdown | SIGTERM handler + write queue flush | None (PM2 kills after 1.6s) | PM2 restart was killing in-flight writes. Flush + 15s kill_timeout prevents data loss. |
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

8. ~~**Ollama GPU sharing:**~~ **Resolved.** Phase 6 (LLM Judge) cancelled. Phase 7 uses Claude API instead of local LLM. No Ollama needed. VPS stays on t3.medium.

9. **Integration test harness:** No way to boot proxy + server on random ports and make real HTTP requests in tests. Needed for verifying end-to-end behavior. Options: (a) `test/helpers/test-server.ts` that starts both, (b) supertest-style wrapper, (c) defer until test coverage becomes a bottleneck.

10. **Schema versioning:** No `schema_version` table or numbered migrations. Schema changes are `CREATE TABLE IF NOT EXISTS` + ad-hoc `ALTER TABLE`. Works for now but agents adding tables may create ordering issues. Consider a lightweight migration framework before Phase 9 (which adds new tables).

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

**P4-PREREQ (Agent Infrastructure) is successful when:**
- PRs get automated test + typecheck results via GitHub Actions
- Deploy is available as a manual workflow trigger (not automatic)
- `pm2 restart grove-server` flushes write queue before shutting down (verify via log)
- Push failures in write-queue.ts emit structured log entries

**CLI-A (Foundation) is successful when:**
- `grove search "test" --json` returns valid JSON with `ok`, `results`, `count` fields
- `grove read "nonexistent" --json` exits 1 with `{"ok": false, "error": "not_found"}` on stderr
- `grove search "test" | cat` auto-detects non-TTY and emits JSON
- `grove write path.md --content "text" --type concept` creates a note without stdin
- `grove graph` and `grove digest` are discoverable top-level commands
- `grove health --json` and `grove metrics --json` return server status
- `grove init --server X --token Y` creates config and validates connection
- `GROVE_TOKEN=xxx grove search "test"` works without a config file

**CLI-B (Consistency) is successful when:**
- `grove trails list` works from any machine (HTTP, not local SQLite)
- `grove search "X" --paths | xargs -I{} grove read "{}"` works
- `grove write path.md --if-hash abc123` exits 1 on conflict with current hash in error
- `grove trails delete <id>` without `--yes` shows what would happen and exits 1

**Phase 4 (Portal) is successful when:**
- Owner can log in with admin key, get a session, and manage keys/trails from the browser
- Usage dashboard shows request volume and latency per tool
- Vault health panel shows note count, sync status, embedding coverage, git status
- Trail consumer can visit a public onboarding page and copy MCP connection config
- All text uses `text-ink`, `text-moss`, `text-harvest`, or opacity variants — no raw Tailwind color classes
- All headings use `font-serif font-medium` — body text uses `font-sans`

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

**P4-PREREQ — Agent Infrastructure (next, prerequisite for everything below):**
1. CI pipeline + graceful shutdown (single agent, small scope)
2. Merge, deploy manually, verify health check

**CLI-A — Foundation (immediately after P4-PREREQ, parallel with Phase 4b):**
1. Agent A: --json + exit codes + structured errors (core refactor)
2. Agent B: --content, init, graph/digest promotion, health/metrics, help (new features)

**Phase 4b — Ops Dashboard (parallel with CLI-A):**
1. Backend APIs: Agents A-D in parallel (trail CRUD, user list, keys/metrics fixes, git stats)
2. Frontend: Agents F-H in parallel (key mgmt, trail mgmt, vault health + usage pages)
3. Consumer: Agent I (trail onboarding page)

**CLI-B — Consistency (after CLI-A + P4-API-1 merged):**
- Trails to HTTP, --paths, --if-hash, whoami (single agent, sequential)

**P5-TAG — Tag & Classification Coverage (can run anytime, independent):**
- Auto-tagging on write + backfill existing notes → trail filtering coverage from 15% to >80%

**Phase 7 — Discovery (can start after P4-PREREQ, parallel with above):**
1. Agents A-B: discovery loop skeleton ‖ ingest command
2. Agents C-D: concept extraction + wikilink wiring ‖ semantic neighbors
3. Agents E-F: discovery digest ‖ bookmarks + post-ingest bootstrap
- CLI-D: `grove discovery`, `grove ingest` land with their server features

**Phase 9a — User Management (after CLI-B):**
1. Agents A-C in parallel (user roles, invite flow, user-scoped keys)
2. Agents D-E in parallel (user mgmt UI, trail sharing UX) — needs Phase 4b dashboard layout
- CLI-D: `grove users list|invite` lands with P9-2

**Phase 9b — Trail Sharing UX (after Phase 9a + Phase 4b):**
- Shareable trail links, trail-scoped grove.md, share-a-note
- CLI-D: `grove share` lands with P9-7

**CLI-C — Module Extraction (when cli.ts exceeds ~1200 LOC):**
- Split into src/cli/ directory structure. Triggered by size, not schedule.

**Phase 4d — Knowledge Views (after Phase 4b):**
- P4-10 (graph explorer), P4-11 (lifecycle dashboard) — deferred, spec when dashboard proves useful

**~~Phase 6~~** — LLM judge: REMOVED FROM SCOPE
**Phase 8** — Multi-vault: deferred (work vault is read-only and auto-generated; low priority)
**~~Phase 9c~~** — Annotations: REMOVED FROM SCOPE
