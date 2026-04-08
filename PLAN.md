# Grove — Implementation Plan

> A hosted knowledge API that makes Obsidian vaults searchable and writable from any Claude surface.

This document is the authoritative implementation spec for Grove. Agents working on this project should read this file first, follow it precisely, and update it as decisions are made or tasks are completed.

## Overview

Grove is a TypeScript API server that wraps a git-tracked Obsidian vault and exposes it as MCP tools. Any Claude surface (app, phone, web, Code) connects to Grove and gets structured access to the vault — search, read, write, with proper auth, sync, and concurrency.

**Stack:** TypeScript, Node.js (>=22), raw `node:http`, SQLite (via QMD), git
**Repo:** `~/src/grove`
**Vault:** `~/life/` (primary), `~/canva/` (deferred — Phase 8)
**Depends on:** `@tobilu/qmd` (search engine), `@modelcontextprotocol/sdk` (MCP transport)
**Deploys to:** AWS g4dn.xlarge (T4 GPU) at `api.grove.md` (44.243.70.208)
**Live:** Phases 0-1 complete — MCP + hybrid search + read/write at `https://api.grove.md`
**Next:** Security hardening → Observability → Portal → Trails (topic-scoped sharing)

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

- [ ] **P2-1: Path traversal guard** (`src/server.ts`)
  Resolve all file paths to absolute, reject anything outside vault root. No `..`, no symlinks escaping the vault. Test with `../../etc/passwd` and `../../.grove/keys.json`. This is exploitable today — top priority.

- [ ] **P2-2: CORS lockdown** (`src/proxy.ts`, `src/server.ts`)
  Replace `*` with explicit allowed origins: `https://claude.ai`, `https://api.grove.md`. CORS `*` with Bearer auth allows any website to make credentialed requests.

- [ ] **P2-3: Request body size limit** (`src/proxy.ts`)
  Hard cap at 1MB on `node:http` layer. Prevents memory/disk exhaustion from malicious or buggy clients.

- [ ] **P2-4: Enforce key scopes** (`src/proxy.ts`)
  Key scopes (read, write) are defined but not checked. Wire up enforcement — read-only keys get 403 on write operations.

#### Phase 2b: Infrastructure Security

- [ ] **P2-5: EBS encryption**
  Enable EBS encryption (AES-256, AWS-managed CMK) on the volume. Free, zero app changes, protects snapshots and S3 backups automatically. Migrate by creating encrypted volume from snapshot. *(Expert correction: LUKS is wrong for AWS — the volume is mounted and decrypted at runtime, so LUKS only protects against physical disk theft, which AWS already handles.)*

- [ ] **P2-6: Daily S3 backups**
  Cron job tars `~/.grove/` (keys, trails, configs) + QMD index and ships to S3 with server-side encryption. Vault itself is in git (GitHub private). QMD index and embeddings are derived and rebuildable, but backing up saves hours of re-embedding.

- [ ] **P2-7: Move secrets out of plaintext JSON**
  OAuth client secrets → environment variables (minimum) or AWS SSM Parameter Store (SecureString). No more plaintext secrets in JSON files.

- [ ] **P2-8: Key TTLs and rotation**
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

- [ ] **P3-1: JSON structured logs** (`src/logger.ts`)
  One JSON line per request to stdout (PM2 captures). Format:
  ```json
  {"ts":"ISO8601","rid":"ulid","method":"POST","path":"/mcp","tool":"query","key_id":"abc123","status":200,"duration_ms":142,"error":null,"bytes_out":2847}
  ```
  Essential fields: timestamp, request ID (`rid`), tool name, key identity (not the raw token), status, duration, error. Add `vault_path` on writes.

- [ ] **P3-2: Request correlation IDs**
  Generate ULID at proxy entry. Pass as `X-Request-Id` header to Grove server. Both layers log the same `rid`. Enables tracing a request through proxy → server → vault op.

- [ ] **P3-3: Audit log for reads**
  Today writes are traced via git commits, but reads are invisible. Log every read with key identity for trail consumers. Store in `~/.grove/audit.jsonl`, rotate daily.

#### Phase 3b: Health & Metrics

- [ ] **P3-4: Deep health check** (`/health`)
  Proxy health must verify downstream: QMD index accessible, embed server responding, vault git status clean. A proxy that says "I'm fine" while QMD is dead is worse than no health check.

- [ ] **P3-5: `/metrics` endpoint** (JSON, not Prometheus)
  Internal counters (reset on restart, fine for dashboard). Persist daily rollups to SQLite for history.
  - `requests_total` by tool name and status code
  - `latency_p50`, `p95`, `p99` (1000-sample rolling reservoir)
  - `errors_total` by type (auth, upstream timeout, write queue, search)
  - `write_queue_depth` and `write_queue_wait_ms`
  - `search_latency_ms` (BM25 vs vector separately)
  - `embedding_latency_ms`
  - `uptime_seconds`

- [ ] **P3-6: BetterStack integration**
  - Ship logs via BetterStack agent (structured JSON from stdout)
  - Uptime monitor: ping `/health` on proxy (8420) every 60s, alert after 2 consecutive failures
  - Error rate alert: >10% over 5-minute window (log-based)
  - Daily dead man's switch: cron hits BetterStack heartbeat URL, alerts if it stops

#### Phase 3 Tests

- Structured log output: unit test verifying log format, field presence
- Health check: integration test with QMD down → health returns unhealthy
- Metrics: unit test for counter increment, percentile calculation

---

### Phase 4: Portal

**Goal:** Web dashboard on `api.grove.md` for managing keys, viewing usage, and (later) configuring trails.

**Prerequisites:** Phase 3 observability in place (dashboard needs metrics to display).

#### Phase 4a: Admin Dashboard

- [ ] **P4-1: Admin auth**
  `GROVE_ADMIN_KEY` in env var. Dashboard login = paste admin key → get session cookie with short TTL. Dashboard bound to `/admin/*` path on the proxy. *(Note: before multi-user, consider binding to 127.0.0.1 and accessing via SSH tunnel for extra safety. Evaluate when trail consumers are real.)*

- [ ] **P4-2: Key management UI**
  View all keys, create new keys, revoke keys. Shows: name, prefix, scope, created date, last used, request count. Replaces the basic web UI from Phase 0.

- [ ] **P4-3: Usage dashboard**
  Request volume over time, latency percentiles, error rate, search latency breakdown (BM25 vs vector). Pulls from `/metrics` endpoint (internal counters), not from BetterStack API.

- [ ] **P4-4: Vault health panel**
  Note count, last sync time, git status, embedding coverage, index health. Pulls from `vault_status` internally.

#### Phase 4b: Trail Management (built during Phase 5)

- [ ] **P4-5: Trail config UI** — create/edit/disable trails, set boundaries, generate consumer keys
- [ ] **P4-6: Trail usage view** — per-trail request volume, filtered/allowed counts, consumer activity
- [ ] **P4-7: Consumer onboarding page** — trail description + MCP connection instructions for each trail

#### Phase 4 Tests

- Auth: session creation, expiry, invalid key rejection
- Key CRUD: create, list, revoke via UI matches CLI behavior
- Dashboard: metrics endpoint returns expected shape, UI renders without error

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

- [ ] **P5-1: Trail config schema** (`src/trails.ts`)
  CRUD operations on `~/.grove/trails.json`. Validate schema, generate IDs, wire to API keys.

- [ ] **P5-2: Trail CRUD CLI**
  `grove trails create "AI Research" --allow-tags "ai,llm,agents" --deny-tags "health,finances" --allow-paths "Resources/" --access read`
  `grove trails list` / `grove trails disable <id>` / `grove trails delete <id>`
  Creating a trail auto-creates a scoped API key (token shown once).

- [ ] **P5-3: Trail resolution in proxy**
  On auth, look up key → trail mapping. Pass trail config to server as request context (header or injected metadata). No trail = full access (owner key).

- [ ] **P5-4: Server-side filtering** (`src/server.ts`)
  Two-layer filter:
  1. **Fast prefilter**: check note frontmatter tags/types/paths against trail allow/deny lists. Deterministic, sub-millisecond.
  2. **(Deferred) LLM judge**: Ollama (Qwen2.5-3B on T4) evaluates survivors against `topic_description`. Soft signal — demote, don't hard-exclude. Log every exclusion for audit.
  
  Apply filter in `query`, `get`, `multi_get`, `list_notes`, `write_note`, `vault_status` per the table above.

- [ ] **P5-5: `filtered_count` in query responses**
  Include `{ total_found, visible, filtered }` counts so consumers know when results were scoped. Helps them decide whether to ask the vault owner for broader access.

- [ ] **P5-6: Trail info in MCP initialize**
  Return trail name, description, visible note count in MCP server capabilities for trail-scoped sessions.

#### Phase 5b: Safety & Eval

- [ ] **P5-7: Tag hygiene audit**
  Before shipping trails, run diagnostics: how many notes have no tags? How many have tags that don't match any trail's allow list? This determines whether tag-based filtering is viable or needs path-based filtering as primary. Run via `vault_status(diagnostics)` + new tag coverage report.

- [ ] **P5-8: Trail filter eval suite**
  Labeled test cases: known-sensitive notes (health, therapy, finances) and known-safe notes (AI, tech, recipes). Create an "AI Research" trail and verify:
  - Precision >95%: sensitive notes never leak through the trail
  - Recall >90%: on-topic notes aren't over-filtered
  Run as `npm run test:trails` with fixture vault.

- [ ] **P5-9: Audit trail for trail access**
  Every trail query logged: `{ ts, trail_id, key_id, tool, query, total_found, visible, filtered }`. Stored in `~/.grove/audit.jsonl`.

- [ ] **P5-10: Blast radius limits**
  Per-trail rate limits: configurable max reads/min, max writes/hour. Default: 60 reads/min, 10 writes/hour per trail. Separate from owner key limits.

- [ ] **P5-11: Snapshot/rollback**
  `grove snapshot` creates a git tag. `grove rollback <tag>` reverts. Automatic snapshot before any bulk operation.

#### Phase 5c: Portal Integration (parallel with 5a)

- [ ] **P5-12: Trail management UI** — create/edit/disable trails from the web dashboard (P4-5)
- [ ] **P5-13: Consumer onboarding page** — public page per trail showing: name, description, connection instructions for Claude.ai MCP (P4-7)
- [ ] **P5-14: Trail usage dashboard** — per-trail request volume, filtered/allowed ratio, consumer activity (P4-6)

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
| Admin auth | Admin key in env var + session cookie | GitHub OAuth, passkey | Simple for single-user. Evaluate hardening when trail consumers are real. |
| LLM judge | Deferred (Phase 6) | Ship with trails, rule-based only | Expert panel: prefilter covers 90%, LLM adds latency and fragility. Ship without, add when proven needed. |
| Ollama binding | 127.0.0.1 only, cgroup-limited | 0.0.0.0 (default) | Default binds to all interfaces — security risk. Cgroup prevents resource starvation of main app. |
| Consumer discovery | `filtered_count` in responses | Hide filtering entirely | Consumers should know results are scoped so they can request broader access. |

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

6. **Tag hygiene for trails:** How many vault notes have no tags or inconsistent tags? If coverage is low, path-based filtering may need to be the primary mechanism for trails, not tags. Run audit before Phase 5 ships (P5-7).

7. **Admin dashboard exposure:** Currently planned as admin key + session cookie on public internet. Security panel recommends binding to 127.0.0.1 + SSH tunnel before multi-user. Decide when trail consumers are real — if only you use the portal, SSH tunnel is fine. If trail consumers need a portal, need proper auth.

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
- Admin can log in, view keys, create/revoke keys from the web dashboard
- Usage dashboard shows request volume and latency over time
- Vault health panel shows note count, sync status, embedding coverage

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

**Phase 1** (complete):
1. ~~P1-1 through P1-15~~ ✅

**Phase 2 — Security Hardening:**
1. **P2-1 + P2-2 + P2-3** — Path traversal, CORS, body size limit (critical, parallelize)
2. **P2-4** — Scope enforcement (depends on nothing, can parallel with above)
3. **P2-5** — EBS encryption (AWS console, independent)
4. **P2-6** — S3 backups (after EBS, so backups are encrypted)
5. **P2-7 + P2-8** — Secrets migration + key TTLs (parallel)

**Phase 3 — Observability:**
1. **P3-1 + P3-2** — Structured logging + correlation IDs (build together)
2. **P3-3** — Audit log for reads (uses the new logging infra)
3. **P3-4** — Deep health check (independent)
4. **P3-5** — Metrics endpoint (independent, uses internal counters)
5. **P3-6** — BetterStack integration (after logging is structured)

**Phase 4 — Portal:**
1. **P4-1** — Admin auth (foundational)
2. **P4-2** — Key management UI
3. **P4-3 + P4-4** — Usage dashboard + vault health (parallel, both read from metrics/status)

**Phase 5 — Trails:**
1. **P5-7** — Tag hygiene audit FIRST (determines if tag filtering is viable)
2. **P5-1 + P5-2** — Trail config schema + CLI (parallel)
3. **P5-3** — Trail resolution in proxy
4. **P5-4 + P5-5 + P5-6** — Server-side filtering + filtered_count + MCP handshake (core, build together)
5. **P5-8** — Filter eval suite (validates the filtering works)
6. **P5-9 + P5-10 + P5-11** — Audit trail + blast radius + snapshot (safety, parallel)
7. **P5-12 + P5-13 + P5-14** — Portal integration (parallel with safety)
