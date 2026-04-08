# Grove — Implementation Plan

> A hosted knowledge API that makes Obsidian vaults searchable and writable from any Claude surface.

This document is the authoritative implementation spec for Grove. Agents working on this project should read this file first, follow it precisely, and update it as decisions are made or tasks are completed.

## Overview

Grove is a TypeScript API server that wraps a git-tracked Obsidian vault and exposes it as MCP tools. Any Claude surface (app, phone, web, Code) connects to Grove and gets structured access to the vault — search, read, write, with proper auth, sync, and concurrency.

**Stack:** TypeScript, Node.js (>=22), raw `node:http`, SQLite (via QMD), git
**Repo:** `~/src/grove`
**Vault:** `~/life/` (Phase 1), `~/canva/` (Phase 2)
**Depends on:** `@tobilu/qmd` (search engine), `@modelcontextprotocol/sdk` (MCP transport)
**Deploys to:** Vultr VPS at `api.grove.md` (45.76.66.214)
**Live:** Phase 0 complete — MCP + hybrid search (BM25 + vector + RRF) at `https://api.grove.md`

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

### Phase 2: Groves & Safety

**Goal:** Share shaped slices of your knowledge with others through **groves** — topic-scoped windows with server-side LLM-as-judge enforcement.

**Prerequisites:** Phase 1 deployed and stable. Foundation score at 40/40.

A grove is: a name + topic instructions (what to engage with, what to refuse) + permission level + API key. Not folder-based ACLs — topic-based boundaries. The LLM judge runs server-side on the VPS, filtering every response before it reaches the consumer.

#### Phase 2a: Grove Infrastructure

- [ ] **P2-1: Grove config schema**
  `~/.grove/groves.json` stores grove definitions. Each grove has: `id`, `name`, `topics` (allow list), `deny` (deny list), `access` (search | read | write), `key_ids` (associated API keys), `created_at`.

- [ ] **P2-2: Grove CRUD CLI**
  `grove create "AI Research" --topics "ai, llm, agents" --deny "health, finances" --access read`
  `grove list` / `grove revoke <id>`
  Creating a grove auto-creates an API key scoped to it.

- [ ] **P2-3: Permission enforcement**
  Proxy checks grove config before forwarding. Search-only keys get snippets (no full content). Read keys get full notes. Write keys can create/update. Enforced in proxy, not in consumer's client.

- [ ] **P2-4: LLM-as-judge filter**
  After Grove server returns results, proxy runs each result through a local model on VPS: "Given these topic instructions, should this note be visible?" Filter or redact before returning to consumer. Model: small/fast (e.g., Qwen-2.5 or similar via Ollama).

- [ ] **P2-5: Grove MCP endpoint**
  Consumer connects their Claude to `https://api.grove.md/mcp` with a grove key. They get a shaped view of your knowledge — can ask questions, search, read (if permitted) — but only see what the grove allows.

#### Phase 2b: Safety Infrastructure

- [ ] **P2-6: Judge eval suite**
  Labeled test cases: known-sensitive notes (health, therapy, finances) and known-safe notes (AI, tech, recipes). Measure precision (>95% — don't leak sensitive) and recall (>90% — don't over-block on-topic). Run as `bash scripts/eval-judge.sh`.

- [ ] **P2-7: Snapshot/rollback**
  `grove snapshot` creates a git tag. `grove rollback <tag>` reverts. Automatic snapshot before any autonomous operation (discovery runs, bulk ingest).

- [ ] **P2-8: Audit trail**
  Every grove query logged: `{ ts, grove_id, key_id, tool, query, filtered_count, allowed_count }`. Every autonomous write logged with reasoning.

- [ ] **P2-9: Blast radius limits**
  Configurable per-grove write limits (max writes/hour). Configurable per-discovery-run limits (max notes created). Default: 10 notes/run, 20 writes/hour/grove.

### Phase 3: Discovery & Onboarding

**Goal:** Knowledge grows autonomously. New content integrates without manual invocation.

**Prerequisites:** Phase 2 stable. Safety infrastructure proven.

#### Phase 3a: Background Discovery

- [ ] **P3-1: Discovery loop**
  Background process on VPS, triggered by git commits and write_note calls. For each changed note: extract entities/concepts, check if concept notes exist, create if not, wire wikilinks.

- [ ] **P3-2: Concept extraction**
  Use local LLM to identify concepts, people, projects from note content. Match against existing vault entities (via list_notes + aliases). Create new concept notes for genuinely new entities.

- [ ] **P3-3: Semantic neighbor surfacing**
  For each new/changed note, find embedding-similar notes that aren't already linked. Log surprising connections to a discovery feed.

- [ ] **P3-4: Discovery digest**
  New `vault_status` mode: `discovery`. Returns what the loop found recently — new concepts created, new links wired, surprising connections. Powers the `/garden` daily practice.

- [ ] **P3-5: Bookmark integration**
  X bookmarks (via `bird` CLI) become a trigger for the discovery loop, not a manual `/garden-forage` invocation. Cron or webhook watches for new bookmarks, ingests them, extracts concepts.

#### Phase 3b: Bulk Onboarding

- [ ] **P3-6: Ingest command**
  `grove ingest <dir>` — reads a directory of files, parses frontmatter/content, deduplicates against existing vault, writes new notes via write_note.

- [ ] **P3-7: Concept bootstrapping**
  After ingest, run discovery loop over all new notes to extract concepts and build the initial graph. This is the cold start path for new users or new content dumps.

### Phase 4: Multi-Vault (deferred)

**Goal:** Add additional vaults (e.g., work vault `~/canva/`) as separate queryable indexes.

**Prerequisites:** Phases 2-3 stable.

This was originally Phase 2 but deferred — groves and discovery are higher impact than multi-vault support. The work vault is read-only and auto-generated; it can wait.

- [ ] **P4-1: Multi-vault config** — per-vault QMD indexes, config.json
- [ ] **P4-2: Per-vault keys** — keys scoped to vault_id
- [ ] **P4-3: Read-only vaults** — config flag, 403 on writes
- [ ] **P4-4: Cross-vault search** — merged RRF, tagged results
- [ ] **P4-5: Graph isolation** — per-vault backlinks, opt-in cross-vault traversal

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

5. **Auto-embed on vault change:** Currently embedding is manual (run embed-node.ts, scp). Should this be automated? Options: (a) cron on Mac, (b) git hook on push, (c) VPS-side embed after sync. Deferred to Phase 1.

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

**Phase 2 is successful when:**
- Work vault is searchable alongside life vault
- Cross-vault search returns results tagged by vault
- No data leakage between vaults

---

## Implementation Order

For agents working on Phase 1a, build in this order:

1. **P1-1** Write queue (foundational — everything depends on this)
2. **P1-2 + P1-3** Vault ops + note validation (can build in parallel)
3. **P1-4** Grove MCP server (the core — registers all 6 tools)
4. **P1-5** Wire proxy → Grove server
5. **P1-6** VPS git push access
6. **P1-7** End-to-end test (plant → harvest → tend → loop)

Phase 1b tasks (P1-8 through P1-15) can be done in any order after 1a is validated.
