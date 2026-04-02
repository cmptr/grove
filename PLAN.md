# Grove — Implementation Plan

> A hosted knowledge API that makes Obsidian vaults searchable and writable from any Claude surface.

This document is the authoritative implementation spec for Grove. Agents working on this project should read this file first, follow it precisely, and update it as decisions are made or tasks are completed.

## Overview

Grove is a TypeScript API server that wraps a git-tracked Obsidian vault and exposes it as MCP tools. Any Claude surface (app, phone, web, Code) connects to Grove and gets structured access to the vault — search, read, write, with proper auth, sync, and concurrency.

**Stack:** TypeScript, Node.js (>=22), raw `node:http`, SQLite (via QMD), git
**Repo:** `~/src/grove`
**Vault:** `~/life/` (Phase 1), `~/canva/` (Phase 2)
**Depends on:** `@tobilu/qmd` (search engine), `@modelcontextprotocol/sdk` (MCP transport)
**Deploys to:** Vultr VPS at `grove.mili.dev` (45.76.66.214)
**Live:** Phase 0 complete — MCP + hybrid search (BM25 + vector + RRF) at `https://grove.mili.dev`

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
- Deployed on Vultr VPS at `grove.mili.dev` with nginx + Let's Encrypt TLS
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
- Domain: `grove.mili.dev` (DNS-only in Cloudflare, nginx handles TLS)
- PM2 processes: `grove-proxy` (8420), `qmd-mcp` (8181), `qmd-server` (8177)
- TEI Docker: `tei-embeddings` on port 8090 (BAAI/bge-base-en-v1.5, `--auto-truncate`)
- API key: `key_a3802af4` (claude-ai, read+write, life vault)

**Tasks:**

- [x] **P0-1: Auth proxy** — `src/proxy.ts`, bearer tokens + OAuth 2.0 (PKCE) for Claude.ai
- [x] **P0-2: Key management** — `src/keys.ts`, create/list/revoke CLI
- [x] **P0-3: Deploy to VPS** — nginx + Let's Encrypt on `grove.mili.dev`
- [x] **P0-4: Register as Claude.ai custom connector** — connected via OAuth, working from all surfaces
- [x] **P0-5a: Hybrid search** — BM25 + vector + RRF fusion via TEI + sqlite-vec (replaced OpenAI API plan with self-hosted TEI for privacy)
- [ ] **P0-5b: Usage journal** — use for 2 weeks, note what's missing

**Key decisions made during Phase 0:**
- **Embeddings: self-hosted TEI** (not OpenAI API) — privacy-first, same bge-base-en-v1.5 model on Mac and VPS
- **Embed on Mac, sync to VPS** — vec0 bulk ops OOM on VPS; Mac embeds via Node.js (not Python — Python 3.14 + vec0 has catastrophic GC issues), scp index to VPS
- **OAuth 2.0 required** — Claude.ai custom connectors only support OAuth, not plain bearer tokens; proxy implements full OAuth flow with PKCE
- **VPS upgraded to 8GB** — 2GB was too small for TEI + QMD + proxy; 8GB/4CPU handles everything comfortably

### Phase 1: Grove Server

**Goal:** Build and deploy the real grove server on Vultr. Replace the tunnel with a proper hosted service.

**Duration:** Estimated 2-3 weeks of development

**Prerequisites:** Phase 0 validation complete. Learnings from 2-week tunnel usage incorporated.

#### 1.1 Project Setup

- [ ] **P1-1: Initialize project**
  ```
  ~/src/grove/
  ├── src/
  │   ├── index.ts              # Entry point
  │   ├── server.ts             # HTTP server + MCP transport
  │   ├── auth.ts               # Token validation middleware
  │   ├── router.ts             # Route handling
  │   ├── notes.ts              # Notes service (read, write, parse)
  │   ├── search.ts             # Search service (QMD wrapper)
  │   ├── vault.ts              # Vault service (git operations)
  │   ├── write-queue.ts        # Serialized write queue
  │   ├── keys.ts               # Key management
  │   ├── logger.ts             # Audit logging
  │   └── types.ts              # Shared types
  ├── test/
  │   ├── notes.test.ts
  │   ├── search.test.ts
  │   ├── auth.test.ts
  │   ├── write-queue.test.ts
  │   └── fixtures/             # Test vault with sample notes
  ├── bin/
  │   └── grove.ts              # CLI entry point
  ├── deploy/
  │   ├── Dockerfile
  │   ├── Caddyfile
  │   └── setup.sh              # VPS setup script
  ├── PLAN.md                   # This file
  ├── CLAUDE.md                 # Agent instructions for this repo
  ├── package.json
  └── tsconfig.json
  ```
  - TypeScript with strict mode
  - Node.js >= 22
  - Dependencies: `@tobilu/qmd`, `@modelcontextprotocol/sdk`, `better-sqlite3`
  - Dev dependencies: `vitest`, `tsx`
  - **No frameworks.** Raw `node:http`. The server is small enough not to need Express/Fastify.

- [ ] **P1-2: CLAUDE.md for the grove repo**
  Write repo-specific agent instructions so sub-agents can work autonomously.
  - Project overview and architecture
  - How to run locally
  - How to run tests
  - Code conventions
  - What not to do

#### 1.2 Core Services

- [ ] **P1-3: Notes service (`src/notes.ts`)**
  The core domain logic. Reads/writes notes with full parsing.

  **`getNote(vaultPath, notePath) → NoteResponse`**
  - Read file from disk
  - Parse YAML frontmatter (regex-based, no external YAML lib needed — but use `yaml` package for robustness)
  - Extract outlinks: all `[[...]]` patterns, resolve piped syntax `[[target|display]]` → target
  - Compute backlinks: grep the vault for `[[Note Name]]` references to this note (cache this — expensive on every read)
  - Compute lifecycle stage: seed/sprout/growing/mature/dormant/withering based on age + modification recency
  - Compute content hash: SHA-256 of raw file content
  - Return structured `NoteResponse`

  **`putNote(vaultPath, notePath, input: NoteInput) → NoteResponse`**
  - Validate frontmatter: `type` must be a known value (concept, person, recipe, project, company, place, journal)
  - Validate path: must be under vault root, must be `.md`, no symlink escapes
  - If `if_hash` provided: compare against current file hash, reject with 409 if mismatch
  - If `idempotency_key` provided: check cache, return cached response if seen
  - Serialize frontmatter to YAML + combine with body content
  - Write file
  - Git commit with key identity: `"grove (<key-name>): update <path>"`
  - Trigger QMD reindex for this file
  - Return the new `NoteResponse`

  **`deleteNote(vaultPath, notePath) → void`**
  - Move to `Archives/` (not actual delete)
  - Add `archived_at` and `archived_by` to frontmatter
  - Git commit
  - Requires `admin` scope

  **`batchGet(vaultPath, paths: string[]) → NoteResponse[]`**
  - Parallel reads for up to 50 paths
  - Return array of responses (with nulls for not-found)
  - Used by harvest/tend workflows that cross-reference many notes

  **Types:**
  ```typescript
  interface NoteResponse {
    path: string
    frontmatter: Record<string, unknown>
    content: string
    outlinks: string[]
    backlinks: string[]
    lifecycle: 'seed' | 'sprout' | 'growing' | 'mature' | 'dormant' | 'withering'
    content_hash: string
    modified_at: string
    created_at: string
  }

  interface NoteInput {
    frontmatter: Record<string, unknown>
    content: string
    if_hash?: string
    idempotency_key?: string
  }

  interface ApiResponse<T> {
    data: T
    meta: {
      request_id: string
      vault_version: string  // git SHA
      api_version: string    // date-based: "2026-04-01"
    }
  }

  interface ApiError {
    error: {
      type: 'not_found' | 'conflict' | 'validation' | 'unauthorized' | 'rate_limited'
      code: string
      message: string
      current_hash?: string  // on conflict, include current state
    }
  }
  ```

- [ ] **P1-4: Search service (`src/search.ts`)**
  Wraps QMD's search capabilities.
  - Initialize QMD store with `createStore()` from `@tobilu/qmd`
  - Expose search as a single function: `search(query, options) → SearchResult[]`
  - Options: `limit`, `mode` (bm25 | vector | rrf), `vault_id`, `fields` (control response size)
  - Return results with path, score, snippet, frontmatter
  - On write, call QMD's incremental update for the changed file
  - **Embedding config:** Self-hosted TEI (bge-base-en-v1.5) on VPS port 8090 for query embedding. Doc embeddings pre-computed on Mac via `embed-node.ts` and synced to VPS. This is already working in Phase 0 — Phase 1 just needs to formalize the search service wrapper around `hybrid-search.ts`.

  **Resolved:** QMD's node-llama-cpp is bypassed entirely. `hybrid-search.ts` handles BM25 (QMD server) + vector (TEI + better-sqlite3 vec0) + RRF fusion directly.

- [ ] **P1-5: Vault service (`src/vault.ts`)**
  Git operations on the vault.

  **`sync(vaultPath) → { version: string, changed: string[] }`**
  - `git pull --rebase` (fetch + rebase to avoid merge commits)
  - Return new HEAD SHA and list of changed files
  - Trigger QMD reindex for changed files

  **`commit(vaultPath, path, message, keyName) → string`**
  - `git add <path>`
  - `git commit -m "<message>"` with key identity
  - Return new commit SHA
  - **Do not push on every commit.** Batch pushes on a 30-second timer or when write queue drains.

  **`push(vaultPath) → void`**
  - `git push origin main`
  - Called by the push timer, not by individual writes

  **`history(vaultPath, path?, since?) → HistoryEntry[]`**
  - `git log` with optional path filter and date filter
  - Returns commit SHA, message, author, date, changed files
  - Used for "what changed since yesterday" queries

- [ ] **P1-6: Write queue (`src/write-queue.ts`)**
  Serializes all mutations to prevent concurrent git operations.
  ```typescript
  class WriteQueue {
    private queue: Promise<void> = Promise.resolve()
    private pushTimer: NodeJS.Timeout | null = null

    async enqueue<T>(fn: () => Promise<T>): Promise<T> {
      // Chain onto the queue so operations run sequentially
      const result = new Promise<T>((resolve, reject) => {
        this.queue = this.queue.then(() => fn().then(resolve, reject))
      })
      this.schedulePush()
      return result
    }

    private schedulePush() {
      if (this.pushTimer) return
      this.pushTimer = setTimeout(() => {
        this.pushTimer = null
        this.enqueue(() => this.vault.push())
      }, 30_000)
    }
  }
  ```
  - All write operations (putNote, deleteNote, sync) go through `enqueue()`
  - Read operations bypass the queue entirely (concurrent reads are safe)
  - Git push batched every 30 seconds

#### 1.3 HTTP Layer

- [ ] **P1-7: Auth middleware (`src/auth.ts`)**
  Token validation on every request.
  - Extract bearer token from `Authorization` header
  - Hash with SHA-256, look up in key store
  - Attach `KeyInfo` to request context (id, name, scopes, vault_id)
  - Check scopes against the operation (read operations need `read`, writes need `write`, deletes need `admin`)
  - Return 401 for invalid/missing tokens, 403 for insufficient scopes
  - Rate limiting: 120 reads/min, 20 writes/min per key (use sliding window counter in memory)
  - `/health` endpoint is the only unauthenticated route
  - **Key store:** Load from `~/.grove/keys.json` on startup, watch for changes

- [ ] **P1-8: Router (`src/router.ts`)**
  HTTP route handling. Raw `node:http`, pattern-matched.

  **REST endpoints:**
  ```
  GET    /v1/vaults/:vault/notes/*path          → notes.get
  PUT    /v1/vaults/:vault/notes/*path          → notes.put
  DELETE /v1/vaults/:vault/notes/*path          → notes.delete
  POST   /v1/vaults/:vault/notes/batch          → notes.batchGet
  POST   /v1/vaults/:vault/search               → search
  POST   /v1/vaults/:vault/sync                 → vault.sync
  GET    /v1/vaults/:vault/history               → vault.history
  GET    /health                                 → health check
  ```

  **Query parameters:**
  - `?fields=frontmatter,backlinks,content` — control response size (default: all fields)

  **Response envelope:**
  Every response wrapped in `{ data: ..., meta: { request_id, vault_version, api_version } }`

  **Error responses:**
  - 400: validation errors (bad frontmatter, invalid path)
  - 401: no/invalid token
  - 403: insufficient scopes
  - 404: note not found
  - 409: conflict (if_hash mismatch) — response includes `current_hash`
  - 429: rate limited — response includes `Retry-After` header
  - 500: internal error

- [ ] **P1-9: MCP transport (`src/server.ts`)**
  MCP server alongside the REST API. Same auth, same services.
  - Use `@modelcontextprotocol/sdk` Streamable HTTP transport
  - Mount at `/v1/vaults/:vault/mcp`
  - Register MCP tools that map to the REST endpoints:

  **MCP Tools (6 total):**

  | Tool | Description | Maps to |
  |------|-------------|---------|
  | `search` | Search notes by keyword or meaning. Returns ranked results with snippets. | `POST /search` |
  | `read_note` | Read a note with parsed frontmatter, links, and metadata. | `GET /notes/*path` |
  | `write_note` | Create or update a note. Validates frontmatter. Use if_hash for safe updates. | `PUT /notes/*path` |
  | `list_notes` | List notes in a folder or matching a pattern. | `GET /notes/*path` (directory) |
  | `batch_read` | Read multiple notes at once. Use for cross-referencing workflows. | `POST /notes/batch` |
  | `vault_history` | What changed recently. Use for awareness: "what's new since yesterday?" | `GET /history` |

  **MCP Tool descriptions must include:**
  - What the tool does and when to use it
  - The vault's structure (Journal/, Resources/, Inbox/, etc.)
  - What frontmatter types exist (concept, person, recipe, etc.)
  - What wikilinks look like (`[[Note Name]]`, `[[Note Name|display text]]`)
  - Example queries that work well
  - That `if_hash` should be used when updating existing notes

  **Important:** Keep tool count at 6. AI agent tool selection degrades past ~10 tools. If you need more operations later, fold them into existing tools as parameters.

- [ ] **P1-10: Audit logger (`src/logger.ts`)**
  Append-only log of all API operations.
  - Log to SQLite table: `timestamp, key_id, key_name, method, path, status, latency_ms`
  - Never log token values
  - Log search queries (useful for understanding usage patterns)
  - Log write operations with before/after content hashes
  - **File:** `~/.grove/audit.db`

#### 1.4 Configuration

- [ ] **P1-11: Server configuration**
  All config via environment variables and/or a config file.
  ```
  # Required
  GROVE_VAULT_LIFE=/path/to/life/vault
  GROVE_KEYS_PATH=~/.grove/keys.json

  # Optional
  GROVE_PORT=8420
  GROVE_HOST=0.0.0.0
  GROVE_PUSH_INTERVAL=30000           # ms between git pushes (default: 30s)
  GROVE_OPENAI_API_KEY=sk-...          # for embeddings
  GROVE_EMBEDDING_MODEL=text-embedding-3-small
  GROVE_LOG_PATH=~/.grove/audit.db

  # Future (Phase 2)
  GROVE_VAULT_WORK=/path/to/work/vault
  ```

  Config file alternative: `~/.grove/config.json`
  ```json
  {
    "vaults": {
      "life": { "path": "/path/to/life", "default": true },
      "work": { "path": "/path/to/canva", "readonly": true }
    },
    "port": 8420,
    "push_interval": 30000
  }
  ```

#### 1.5 CLI

- [ ] **P1-12: Grove CLI (`bin/grove.ts`)**
  Thin client over the REST API. Also handles server management.

  ```bash
  # Server management
  grove serve                          # Start the server
  grove serve --daemon                 # Start as background process

  # Key management
  grove keys create --name "phone"     # Create API key, print token once
  grove keys list                      # List keys (no tokens shown)
  grove keys revoke <id>               # Revoke a key
  grove keys rotate <id>               # Rotate with 24h grace period

  # API client (talks to the server)
  grove search "taste graphs"          # Search
  grove read "Resources/Concepts/Taste Graph.md"  # Read a note
  grove write "Inbox/new-idea.md" --type concept  # Create a note
  grove history --since yesterday      # What changed
  grove sync                           # Trigger git sync

  # Config
  grove config                         # Show current config
  ```

  The CLI reads server URL and API key from `~/.grove/cli.json`:
  ```json
  {
    "server": "https://grove.example.com",
    "token": "grove_live_..."
  }
  ```

#### 1.6 Deployment

- [ ] **P1-13: Dockerfile**
  ```dockerfile
  FROM node:22-slim
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci --production
  COPY dist/ ./dist/
  COPY bin/ ./bin/
  EXPOSE 8420
  CMD ["node", "dist/index.js"]
  ```
  - Vault is mounted as a volume, not baked into the image
  - Keys file mounted as a volume
  - Git credentials mounted (for push/pull)

- [ ] **P1-14: VPS setup script (`deploy/setup.sh`)**
  Idempotent setup for Vultr VPS.
  - Install Node.js 22, git, Caddy
  - Clone vault repo(s) via git
  - Set up SSH keys for git push/pull
  - Install grove as a systemd service
  - Configure Caddy for TLS (auto HTTPS via Let's Encrypt)
  - Set up log rotation
  - Set up cron for `git pull` every 60 seconds (backup sync in case webhooks miss)
  - Configure firewall: only 80, 443, 22

  **Caddy config (`deploy/Caddyfile`):**
  ```
  grove.yourdomain.com {
    reverse_proxy localhost:8420
  }
  ```

- [ ] **P1-15: Register as Claude.ai connector**
  - Add `https://grove.yourdomain.com/v1/vaults/life/mcp` as custom connector
  - Test from all surfaces: web, desktop, mobile
  - Verify search, read, and write operations work

#### 1.7 Testing

- [ ] **P1-16: Test fixtures**
  Create a small test vault in `test/fixtures/vault/` with:
  - 5-10 sample notes across Resources/, Journal/, Inbox/
  - Proper frontmatter, wikilinks, backlinks
  - A git repo initialized
  - Used by all test files

- [ ] **P1-17: Unit tests**
  - `notes.test.ts`: frontmatter parsing, wikilink extraction, backlink computation, path validation, lifecycle calculation, content hash, optimistic concurrency (if_hash)
  - `search.test.ts`: QMD integration, result formatting, field selection
  - `auth.test.ts`: token validation, scope checking, rate limiting, key rotation
  - `write-queue.test.ts`: serialization, concurrent write handling, push batching

- [ ] **P1-18: Integration tests**
  - Full request cycle: auth → route → service → filesystem → response
  - Concurrent write scenarios: two agents writing to the same note
  - Conflict detection and resolution flow
  - Git commit verification (key identity in commit message)
  - Search after write (index consistency)

- [ ] **P1-19: Search quality test set**
  Before deploying simplified search (BM25 + vector + RRF without reranker/expansion):
  - Record 20-30 real queries against current QMD with full pipeline
  - Record top-5 results for each
  - Run same queries against simplified pipeline
  - Diff results, document any quality regressions
  - Decide whether to accept or adjust

### Phase 2: Multi-Vault (work vault)

**Goal:** Add the work vault (`~/canva/`) as a second queryable index.

**Prerequisites:** Phase 1 deployed and stable.

- [ ] **P2-1: Multi-vault config**
  Add `work` vault to `~/.grove/config.json`. Each vault gets its own QMD index (QMD already supports `--index` flag for separate SQLite DBs).

- [ ] **P2-2: Per-vault keys**
  Keys are already scoped to `vault_id`. Create separate keys for work vault access.

- [ ] **P2-3: Read-only vaults**
  Work vault should be read-only (it's auto-generated by secondbrain). Config flag: `"readonly": true`. Write operations return 403.

- [ ] **P2-4: Cross-vault search**
  `POST /v1/search?vaults=life,work` — searches both indexes, merges results via RRF, tags each result with its vault origin. Auth check: key must have read access to all requested vaults.

- [ ] **P2-5: Graph isolation**
  Wikilinks in work vault do NOT resolve to life vault notes (and vice versa) unless explicitly opted in. Backlinks are per-vault by default. Cross-vault graph traversal is a separate, opt-in operation.

### Phase 3: Sharing

**Goal:** Let other people search vaults you own.

**Prerequisites:** Phase 2 stable, clear usage patterns established.

- [ ] **P3-1: User model**
  Add `user_id` to API keys. Users can have keys for vaults they're granted access to.

- [ ] **P3-2: Sharing permissions**
  Vault owner can grant access levels: `search` (search + snippets only), `read` (full note content), `write` (create/update).

- [ ] **P3-3: Snippet-only mode**
  For shared vaults, search can return snippets without full content. Protects sensitive notes while enabling discovery.

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

4. ~~**Domain name:**~~ **Resolved.** `grove.mili.dev`

5. **Auto-embed on vault change:** Currently embedding is manual (run embed-node.ts, scp). Should this be automated? Options: (a) cron on Mac, (b) git hook on push, (c) VPS-side embed after sync. Deferred to Phase 1.

---

## Success Criteria

**Phase 0 is successful when:**
- ✅ You can search your vault from Claude.ai on your phone and get relevant results
- ✅ You can read a note and see its content
- ✅ Hybrid search (keyword + semantic) returns high-quality results
- [ ] You've used it daily for 2 weeks and documented what's missing (P0-5b)

**Phase 1 is successful when:**
- Grove server runs on Vultr, accessible from all Claude surfaces
- Search quality matches or exceeds current QMD (verified by test set)
- Write operations work with proper concurrency control
- All writes are traceable in git log to the key that made them
- You've used it daily for a week without data loss or corruption

**Phase 2 is successful when:**
- Work vault is searchable alongside life vault
- Cross-vault search returns results tagged by vault
- No data leakage between vaults

---

## Implementation Order

For agents working on this project, build in this order:

1. **P1-1 → P1-2:** Project setup and CLAUDE.md
2. **P1-6:** Write queue (foundational — everything depends on this)
3. **P1-3:** Notes service (the core domain logic)
4. **P1-5:** Vault service (git operations)
5. **P1-7:** Auth middleware
6. **P1-8:** Router (wires everything together)
7. **P1-4:** Search service (QMD integration)
8. **P1-9:** MCP transport
9. **P1-10:** Audit logger
10. **P1-16 → P1-18:** Tests
11. **P1-11:** Configuration
12. **P1-12:** CLI
13. **P1-13 → P1-14:** Deployment
14. **P1-15:** Claude.ai registration
15. **P1-19:** Search quality validation

Phase 0 tasks (P0-1 through P0-5) can be done in parallel with early Phase 1 work, or as a standalone sprint beforehand.
