# Grove Ideas

Ideas for the Grove roadmap. Sparks live here until they're shaped enough to graduate into PLAN.md.

## How this works

Tell me an idea — a sentence, a half-thought, a "what if." I'll capture it as a spark. When you want to develop one, we'll shape it together until it's ready for PLAN.md.

**Stages:**
- **Spark** — raw idea, one line
- **Shaped** — problem, approach, and open questions defined
- **Ready** — spec'd enough to become a PLAN.md task or phase

---

## Sparks

- **Growth prompting heartbeat** — proactive system that prompts the user with questions designed to grow the graph in the right direction (fill gaps, connect islands, deepen thin concepts)

---

## Shaped

### Encryption at Rest

**Problem:** Grove processes users' most sensitive personal knowledge. As a multi-vault SaaS product, users need to trust that Grove operators (and anyone who compromises disk/git/backups) cannot read their data. True client-side E2E would kill server-side search, discovery, and embedding — the core value prop.

**Sketch:** Encrypted-at-rest with in-memory-only plaintext processing.
- Each vault gets a unique encryption key (AES-256-GCM or similar)
- Key is escrowed on the server, encrypted with the user's passphrase (PBKDF2/Argon2 derived)
- On request: decrypt vault key with passphrase → process in memory → never persist plaintext to disk
- Git repo stores ciphertext. Backups are ciphertext. Disk is ciphertext.
- Search indexes (FTS5, embeddings) are encrypted at rest, decrypted into memory on server start
- Transit: already TLS. No change needed.
- Trust story: "Your vault is encrypted with a passphrase only you know. We can't read it without your passphrase."

**Dependencies:** Per-vault isolation (needs multi-vault architecture). Passphrase UX in grove.md.

**Success signal:** `git clone` of a vault repo yields unreadable ciphertext. Server restart requires passphrase (or cached session) to resume serving. Users see "encrypted" badge in grove.md.

**Open questions:**
- How does passphrase caching work across server restarts? Session-based unlock? Auto-lock timeout?
- What happens if user forgets passphrase? No recovery by design, or optional recovery key?
- Do search indexes need separate encryption, or is the DB-level encryption (SQLCipher) enough?
- How does this interact with Obsidian local sync? User's local copy is plaintext, server copy is encrypted — git pull needs a decrypt step or separate sync mechanism.

---

### User Profile & Trail Config UX

**Problem:** Managing users, trails, keys, and permissions currently requires the CLI or raw API calls. For a multi-vault SaaS product, vault owners need a web UI to manage their space — and trail consumers need a way to see/configure their access.

**Sketch:** Extend grove.md (the existing Vercel app) with settings/management pages.
- **Owner dashboard:** manage trails (create, edit scopes, enable/disable), manage users/invites, view API keys, see usage metrics, configure vault settings
- **User profile:** change email, manage sessions, see which trails you have access to
- **Trail config:** owners configure allow/deny paths, types, tags via a visual editor (not raw JSON)
- Builds on existing auth flow (magic links, sessions, OAuth) already in grove.md

**Dependencies:** Existing grove-www codebase — need to audit what's already built before scoping new work. REST API already exposes most management endpoints.

**Success signal:** A vault owner can create a trail, configure its scope, invite a user, and the user can log in and browse their trail — all without touching a terminal.

**Open questions:**
- What already exists in grove-www? Need to audit before scoping delta work.
- Should trail consumers be able to customize their own view (theme, layout, pinned notes)?
- Billing/plan management — does this live here or is it a separate concern?

---

### Graph Health Heartbeats

**Problem:** Knowledge graphs decay silently — orphan notes accumulate, links break, embedding coverage drifts, concepts duplicate. Current diagnostics (`vault_status diagnostics`) exist but require manual invocation and only report problems. For a product, graph health should be monitored automatically, and non-risky fixes should be applied without asking.

**Sketch:** Automated graph health system with three tiers: monitor → alert → auto-heal.
- **Metrics (deeper than current):** link density trend, orphan rate over time, embedding coverage %, concept cluster health (are clusters growing or fragmenting?), growth velocity (notes/week, links/week), staleness distribution, duplicate detection rate
- **Automated monitoring:** cron job (daily or configurable) runs diagnostics, stores results in DB as time series
- **Auto-healing (non-risky only):**
  - Fix broken wikilinks when target was renamed (fuzzy match → auto-update)
  - Add missing backlinks
  - Re-embed notes with stale/missing embeddings
  - Flag (but don't auto-merge) near-duplicate concepts
  - Flag (but don't auto-delete) long-orphaned notes
- **Alerting:** surface issues in grove.md dashboard, optional email digest

**Dependencies:** Discovery system (shares entity extraction infra). Vault-agnostic structure (metrics shouldn't assume PARA).

**Success signal:** A vault owner logs into grove.md and sees a health score with trend line. Broken links auto-fixed overnight. Orphan notes flagged with suggested actions. Zero manual diagnostics needed.

**Open questions:**
- What's "risky" vs "non-risky"? Where's the auto-fix boundary? Renaming a broken link seems safe. Merging duplicate concepts could lose nuance.
- How do we store time-series health data? New DB table? Or append to a vault note?
- Should auto-healing be opt-in per fix type, or all-or-nothing?
- How does this interact with trails — does each trail get its own health score?

---

### Image Uploads as Graph Nodes

**Problem:** Knowledge isn't just text. Photos, diagrams, screenshots, and visual references are critical context that currently can't be stored or linked in Grove. For a visual thinker (or anyone with recipes, travel notes, design work), images need to be first-class nodes — searchable, taggable, linkable.

**Sketch:** Image upload API + external storage + vault reference notes.
- **Upload:** `POST /v1/images` accepts PNG, JPG, WebP. Stores in R2/S3 (not git — keeps repo lean).
- **Vault reference:** Each image gets a companion `.md` note in the vault with frontmatter (type: image, tags, source URL, alt text, dimensions) and an embed: `![alt](https://assets.grove.md/{vault_id}/{hash}.{ext})`
- **Auto-tagging:** On upload, run image through a vision model (Claude or similar) to extract: description, detected objects/concepts, suggested tags, OCR text. Store in frontmatter.
- **Graph integration:** Image notes are regular notes — they have backlinks, appear in search, can be wikilinked from other notes. `[[My Diagram]]` just works.
- **Search:** Image descriptions + OCR text are indexed for BM25/vector search. "Find my architecture diagram" works.
- **MCP tool extension:** Extend `write_note` to accept binary upload, or add image-specific parameter to existing tools.

**Dependencies:** External storage setup (R2 bucket, CDN). Vision model API access. Vault-agnostic structure (where do image notes land?).

**Success signal:** User uploads a photo via API or grove.md. Auto-tagged note appears in vault. Searching "pasta recipe photo" finds it. Other notes can `[[link]]` to it.

**Open questions:**
- Storage: S3 vs Cloudflare R2? R2 is cheaper (no egress fees), good fit for a CDN-backed product.
- Size limits? Resize on upload? Generate thumbnails?
- How does this work with Obsidian locally? Obsidian expects attachments in a folder — do we sync the image files too, or just the reference notes?
- Does the 6-tool MCP limit mean we fold image upload into `write_note`, or is this a REST-only feature?

---

### Pinterest-Style Image View

**Problem:** Once images are graph nodes, you need a way to browse them visually — not just as a list of filenames. A masonry/grid layout makes image-heavy vaults (recipes, travel, design) feel alive and browsable. This is also a compelling trail experience for consumers.

**Sketch:** Visual grid component in grove.md, available to both owners and trail consumers.
- **Masonry layout:** responsive grid of image thumbnails, lazy-loaded
- **Filtering:** by tag, type, date range, connected concept (e.g., "show me all images linked to [[Italy Trip]]")
- **Click-through:** opens the image note with full metadata, backlinks, and related images
- **Trail scoping:** trail consumers see only images within their trail scope. A "Recipes" trail shows only recipe images.
- **Sort:** by date added, by connection count, by tag

**Dependencies:** Image uploads as graph nodes (need images first). Thumbnail generation. CDN for fast loading.

**Success signal:** Open grove.md, click "Images" in nav. See a visual grid of your vault's images. Filter by tag. Click one — see the note with all its links. Share a trail and the consumer sees the same grid, scoped to their access.

**Open questions:**
- Is this a dedicated page/route in grove.md, or a view mode that can be applied to any note list?
- Lightbox or full-page detail view?
- Infinite scroll or pagination?
- Performance: how many images before this gets slow? Virtualization needed?

---

### Vault-Agnostic Structure

**Problem:** Grove hard-codes PARA folder conventions throughout: `notes-validate.ts` enforces folder→type mapping, `discovery-extract.ts` builds vocab from `Resources/*`, `vault-stats.ts` counts by PARA folders. This locks Grove to one organizational philosophy. For a multi-vault product, users bring their own vault structure — Zettelkasten, flat folders, custom hierarchies, whatever.

**Sketch:** Convention-based defaults with dead-simple configuration override.
- **Vault config file:** `.grove/config.yaml` (or `grove.config.yaml` in vault root) declares:
  ```yaml
  structure:
    journal: "Journal/"           # or "daily/" or "logs/" or null (no journal convention)
    entities:                     # where auto-created entities land
      default: "Inbox/"           # fallback for all entity types
      concept: "Concepts/"        # optional per-type override
      person: "People/"
    private_paths: ["Private/", "Areas/Health/"]
  ```
- **Smart defaults:** If no config exists, Grove auto-detects structure on first index:
  - Scans top-level folders, matches against common patterns (PARA, Zettelkasten, flat)
  - Generates a default config the user can tweak
  - Falls back to: frontmatter `type` is authoritative, no folder enforcement, entities go to `Inbox/`
- **Validation changes:** `notes-validate.ts` reads config instead of hard-coded paths. Type is determined by frontmatter, not folder. Folder validation becomes optional (warn, not reject).
- **Discovery changes:** Entity extraction reads config for target paths. Unconfigured vaults get entities in a configurable staging path (default: `Inbox/`).
- **Migration:** Existing PARA vaults get auto-generated config matching current behavior. Zero disruption.

**Dependencies:** None — this is foundational and should be early.

**Success signal:** A user with a Zettelkasten vault (flat folder, no PARA) connects to Grove. Auto-detection generates a config. Search, discovery, and write operations all work. They tweak one path in config and it takes effect immediately.

**Open questions:**
- Auto-detection: how reliable can this be? What if a vault doesn't match any known pattern?
- Should config be in the vault (`.grove/config.yaml`) or in the Grove DB? Vault-side is portable. DB-side is centralized.
- How does this interact with the existing QMD index, which has its own assumptions about path structure?

---

### DELETE/Move Endpoint

**Problem:** Grove can create and update notes but can't delete or move them. This blocks vault reorganization, inbox processing, lifecycle management (archiving stale notes), and the graph health auto-healer. The write_note tool is append/update only.

**Sketch:** Two new REST endpoints; fold into existing MCP tools.
- **`DELETE /v1/notes/{path}`** — soft delete by default (move to configurable archive path), hard delete with `?hard=true`
  - Soft delete: moves file to `Archives/` (or configured trash path), commits as `grove (keyname): archive {path}`
  - Hard delete: removes file from disk, commits as `grove (keyname): delete {path}`
  - Both: remove from search index, re-compute backlinks for affected notes
  - Optimistic concurrency: optional `If-Match` hash to prevent deleting a note that changed since you read it
- **`PATCH /v1/notes/{path}` with `move_to` field** — rename/move a note to a new path
  - Updates all incoming wikilinks across the vault (find-and-replace `[[old]]` → `[[new]]`)
  - Commits as `grove (keyname): move {old} → {new}`
  - Reindex both old and new paths
- **MCP integration:** Add `delete` and `move_to` parameters to `write_note` tool (stays within 6-tool limit)
- **Trail scoping:** DELETE/move requires write permission on the trail. Trail must allow both source and destination paths for moves.
- **Write queue:** All operations go through the existing serial write queue. No new concurrency concerns.

**Dependencies:** Vault-agnostic structure (archive path should be configurable). Wikilink update logic for moves.

**Success signal:** `grove delete "Inbox/old-idea.md"` archives the note. `grove move "Inbox/idea.md" "Resources/Concepts/idea.md"` moves it and updates all backlinks. Both show up in git log with clear audit trail.

**Open questions:**
- Should soft-delete preserve the original path in frontmatter (e.g., `archived_from: Inbox/old-idea.md`) for potential un-archive?
- Wikilink update on move: how thorough? Just `[[exact name]]` matches, or also partial matches and aliases?
- Bulk operations? `DELETE /v1/notes?prefix=Inbox/stale/` for batch cleanup?

---

## Ready

<!-- Fully shaped ideas waiting to be moved into PLAN.md -->
