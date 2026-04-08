# Grove

### your knowledge, everywhere your AI is.

Give your AI a persistent memory that works from every surface — phone, laptop, web, terminal. One vault. Every client.

**One URL. Any MCP client.** Add this to Claude, ChatGPT, Cursor, or any MCP-compatible client:

```
https://api.grove.md/mcp
```

```
┌─────────────────────────────────────────────────────────┐
│                    Claude (any surface)                  │
│              phone · web · desktop · Code                │
└──────────────────────┬──────────────────────────────────┘
                       │ MCP (Streamable HTTP + OAuth)
                       ▼
┌─────────────────────────────────────────────────────────┐
│                    Grove Server                          │
│   Auth · Rate Limiting · Write Queue · Graph Analysis    │
└──────────────────────┬──────────────────────────────────┘
                       │
            ┌──────────┼──────────┐
            ▼          ▼          ▼
        Hybrid      Vault      Write
        Search      (git)      Queue
      BM25+Vec               (mutex)
            │          │          │
            ▼          ▼          ▼
┌─────────────────────────────────────────────────────────┐
│           Your Obsidian Vault (git-tracked)              │
│           markdown files · frontmatter · wikilinks       │
└─────────────────────────────────────────────────────────┘
```

Karpathy's [LLM Knowledge Bases](https://x.com/karpathy/status/2039805659525644595) thread described the problem: "I think there is room here for an incredible new product instead of a hacky collection of scripts." He's using brute-force context windows and LLM-maintained index files to manage a personal knowledge base in Obsidian. That works at 100 articles. It doesn't work at 1,000 notes accumulated over years — journal entries, concept notes, people, recipes, projects — where the connections between ideas matter as much as the ideas themselves.

Grove is the infrastructure layer. Not another note-taking app. Not a RAG pipeline. A hosted API that wraps your git-tracked vault and exposes it as structured MCP tools with search, read, write-back, and graph analysis. Your vault stays yours — markdown files in a git repo, editable in Obsidian, versioned forever.

## How I got here

I keep my life in an Obsidian vault. ~1,000 notes, PARA-organized, git-tracked. Journal entries going back years. Concept notes on ideas I've been developing across multiple jobs. People, recipes, a financial plan, business notes. Connected with wikilinks into a knowledge graph.

I built a set of Claude skills to tend this vault like a garden — searching for notes, planting new concepts, harvesting entities from journal entries, detecting withering ideas that need attention. It worked. But only from my laptop. Only in Claude Code. Only when Obsidian was open and the local search server was running.

Then I opened Claude on my phone during a conversation and realized: it had no idea who I was. Every concept, every person, every connection — gone. I was starting from zero in every conversation that wasn't on my one machine.

So I put the search engine on a VPS. Added auth. Added write-back so Claude could plant notes from anywhere, not just read them. Added frontmatter validation so agents couldn't corrupt the vault. Added a graph analyzer so Claude could understand the shape of my knowledge, not just search it. Every write creates a git commit. Every commit is auditable. The vault is the source of truth — the index is derived.

Three weeks in, I haven't manually searched my own notes once. Claude finds what I need in ~30ms from any surface. When it learns something new in a conversation, it plants it. The knowledge compounds.

## The six tools

Grove exposes exactly six MCP tools. Not twelve, not twenty. Six. Agent tool selection degrades past ~10 tools, so these are carefully designed to compose into higher-level workflows.

### `query` — hybrid search

Combines BM25 keyword matching and vector embeddings via Reciprocal Rank Fusion. Supports three sub-query types: `lex` (exact terms), `vec` (semantic meaning), and `hyde` (hypothetical document — describe what the answer looks like).

```json
{
  "searches": [
    {"type": "lex", "query": "taste graph"},
    {"type": "vec", "query": "how design preferences propagate through social networks"}
  ],
  "intent": "research on aesthetic preference modeling"
}
```

~30ms per query. Self-hosted embeddings (bge-base-en-v1.5, 768-dim). No OpenAI dependency. No data leaves your infrastructure.

### `get` — read a note

Fuzzy path resolution. Say `"Taste Graph"` instead of `"Resources/Concepts/Taste Graph.md"`. Returns frontmatter (parsed), content, and a content hash for optimistic concurrency on writes.

Resolution order: direct path → strip prefixes → journal date patterns → case-insensitive basename → alias lookup → BM25 fallback.

### `multi_get` — batch read

Read multiple notes by glob pattern or comma-separated list. `"Resources/People/*.md"` returns all people notes. Capped at 50 per request.

### `write_note` — create or update

The part that makes this more than a search engine. Claude creates a note → server validates frontmatter (type, tags, required fields, path/type consistency) → writes to disk → `git add` → `git commit` → synchronous reindex → fire-and-forget embedding → return.

Every write goes through a serialized mutex queue. No concurrent git operations, ever. Optimistic concurrency via content hashing — if the note changed since you last read it, the write is rejected.

```json
{
  "path": "Resources/Concepts/Context Engineering.md",
  "frontmatter": "{\"type\": \"concept\", \"tags\": [\"concept\", \"ai\"]}",
  "content": "The practice of shaping what goes into an LLM's context window..."
}
```

### `list_notes` — browse the vault

Glob-based listing with metadata. Check for duplicates before creating. Get the entity vocabulary for a folder. Scan inbox items.

### `vault_status` — five modes

| Mode | What it does |
|------|-------------|
| `health` | Note count, last commit, vault path |
| `history` | Recent git log, filterable by date and path |
| `diagnostics` | Orphan notes, broken wikilinks, missing frontmatter, stale inbox |
| `graph` | Brandes' centrality, BFS clusters, bridge detection, most-connected hubs |
| `digest` | Lifecycle classification: seeds → sprouts → growing → mature → dormant → withering |

The digest mode is what powers the daily garden practice. It stratifies every note by age, backlink count, word count, and modification recency. Seeds are ideas less than a week old. Withering notes haven't been touched in six months and have almost no connections. The agent surfaces what needs attention without you having to remember what's in the vault.

## Why not the 24 existing Obsidian MCP servers?

There are already [24 Obsidian MCP servers](https://mcp.so) on the registry. Every one of them is:

- **Local-only.** Runs on your laptop, works from that laptop. Open Claude on your phone — nothing.
- **Read-only.** Search and retrieve, but no write-back. Knowledge flows one direction.
- **Flat filesystem.** Treats your vault as a bag of text files. No frontmatter validation, no type system, no vault conventions.

Grove is remote, bidirectional, and opinionated. It treats your vault as a structured knowledge base with rules — types, required fields, path conventions — that agents must respect. It won't let Claude corrupt your vault.

| | Local MCP servers | Grove |
|---|---|---|
| Works from phone/web | No | Yes |
| Write-back | No | Yes, with validation + git commit |
| Search | Keyword or vector | Hybrid BM25 + vector (RRF) |
| Graph analysis | No | Centrality, clusters, lifecycle |
| Auth | None needed | OAuth 2.0 + bearer tokens |
| Embeddings | Usually OpenAI API | Self-hosted, privacy-first |

## The write flow

This is the part I spent the most time getting right. Agents are eager writers and sloppy validators. The write path is intentionally strict:

```
1. Proxy validates bearer token, checks rate limit (20 writes/min)
2. Server validates:
   - Path: no traversal, inside vault, .md only, no symlinks
   - Frontmatter: type in whitelist, required fields present, tags include type
   - Path/type consistency (Resources/Concepts/* must be type:concept)
   - File size < 100KB
   - Optimistic concurrency: if_hash must match current content
3. Write queue (mutex):
   - Write file to disk
   - git add → git commit (with API key identity)
   - Synchronous QMD reindex
   - Fire-and-forget: embed new content
4. Return content_hash + commit SHA
5. Batched git push every 30 seconds
```

Server is the sole writer to git. Local machines pull. One direction. No split-brain.

## Architecture

```
                    ┌──────────────┐
                    │ Auth Proxy   │ :8420
                    │ OAuth + PKCE │
                    │ Rate limiting│
                    │ Audit log    │
                    └──────┬───────┘
                           │
                    ┌──────┴───────┐
                    │ Grove Server │ :8190
                    │ 6 MCP tools  │
                    │ Write queue  │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────┴──┐  ┌─────┴────┐  ┌───┴────┐
       │ QMD     │  │ TEI      │  │ git    │
       │ BM25    │  │ Vectors  │  │ vault  │
       │ :8177   │  │ :8090    │  │ ~/life │
       └─────────┘  └──────────┘  └────────┘
```

- **TypeScript**, ~2,500 LOC, raw `node:http` (no frameworks)
- **Auth:** OAuth 2.0 with PKCE for Claude.ai custom connectors, bearer tokens for CLI/API
- **Search:** QMD (BM25) + TEI (bge-base-en-v1.5 embeddings) + RRF fusion
- **Persistence:** Git repo. Every note is a markdown file. Every mutation is a commit.
- **Rate limiting:** 120 reads/min, 20 writes/min per API key. LRU idempotency cache.

## Self-hosting

Grove runs on a 4-core VPS ($24/mo). Here's how to deploy your own:

### Prerequisites

- Node.js >= 22
- Git
- A git-tracked Obsidian vault (or any folder of markdown files)
- [QMD](https://github.com/tobilu/qmd) for search indexing
- Docker (for TEI embeddings, optional — falls back to BM25-only)

### Setup

```bash
git clone https://github.com/jmilinovich/grove.git
cd grove
npm install

# Create an API key
grove keys create my-key
# → grove_live_abc123... (save this, it's shown once)

# Start QMD (search engine)
qmd serve --vault ~/your-vault --port 8177

# Start Grove
npm run proxy
```

### VPS deployment

```bash
# On your VPS:
git clone https://github.com/jmilinovich/grove.git
cd grove && npm install && npm run build

# PM2 for process management
pm2 start dist/proxy.js --name grove-proxy
pm2 start "qmd serve --vault /root/vault --port 8177" --name qmd-server

# Nginx for TLS (use certbot for Let's Encrypt)
# Proxy pass to localhost:8420
```

Vault syncs every 5 minutes via cron. Embeddings are pre-computed on your local machine (Apple Silicon is fast) and synced to VPS via scp. See `sync-index.sh`.

## The garden: how I actually use this

Grove is the infrastructure. The garden is the practice. I have seven Claude skills that compose Grove's six tools into a daily knowledge workflow:

| Skill | What it does | Grove tools used |
|-------|-------------|-----------------|
| `/garden` | Daily review — surfaces seeds, sprouts, withering notes | `vault_status` (digest) |
| `/garden-seek` | Hybrid search across the vault | `query` |
| `/garden-plant` | Create new entity notes with proper scaffolding | `write_note`, `list_notes`, `query` |
| `/garden-harvest` | Extract entities from journal entries, wire up wikilinks | `get`, `multi_get`, `write_note` |
| `/garden-tend` | Vault diagnostics — orphans, broken links, stale inbox | `vault_status` (diagnostics) |
| `/garden-wander` | Random walks on the knowledge graph | `vault_status` (graph), `multi_get` |
| `/garden-forage` | Evaluate bookmarks and promote aligned ones to vault notes | `query`, `write_note` |

The lifecycle: **forage** brings in raw material → **plant** scaffolds new entities → **harvest** extracts connections from journal entries → **garden** surfaces what needs attention → **tend** finds structural issues → **wander** discovers unexpected connections. Knowledge compounds across every conversation.

These skills are [open source](https://github.com/jmilinovich/grove) and designed to be adapted. The pattern generalizes — you don't need my vault structure to use Grove.

## The lineage

```
Obsidian (5M+ users, local-first markdown vaults)
  │
  ├── 24 MCP servers (local-only, read-only, flat filesystem)
  │
  ├── Karpathy's "LLM Knowledge Bases" (Apr 2026)
  │     Context windows + LLM-maintained indices
  │     "There is room for an incredible new product"
  │
  └── Grove (this)
        Remote, bidirectional, vault-aware
        6 structured tools, hybrid search, graph analysis
        Self-hosted, privacy-first, git-native
```

MCP is now an [open standard](https://modelcontextprotocol.io/) under the Linux Foundation, backed by Anthropic, Google, and OpenAI. "Knowledge & Memory" is the largest category in the MCP registry at 283 servers. The protocol is infrastructure, not a fad.

## What's next

- **Multi-vault** — Add a second vault (work knowledge base) with per-vault keys and cross-vault search
- **grove.md** — A hosted version where you connect your GitHub repo and get an MCP endpoint. No VPS required. Cross-client: Claude, ChatGPT, Cursor, anything MCP.
- **Sharing** — Permissions model for selective vault access (show someone your recipes but not your journal)

## When you don't need Grove

You don't need it if your vault is small enough to paste into a context window. You don't need it if you only use one AI client on one machine. You don't need it if your notes don't have structure worth preserving.

You need it when you want your AI to know who you are regardless of which surface you're talking to it from. When you want knowledge to compound across conversations instead of evaporating. When you have a vault with real structure — types, conventions, connections — and you want agents to respect that structure, not steamroll it.

## License

MIT
