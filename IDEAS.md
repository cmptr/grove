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

- **Open source calibration** — decide what's the right amount of Grove to open-source (SDK? proxy? nothing? everything minus hosted infra?)
- **Extract design system** — pull a coherent design system out of the current Grove UI so future surfaces stay visually consistent
- **SOC2 baseline** — SSO, encryption at rest/transit, access logs, no prod access without MFA — the minimum surface to be SOC2-ready
- **Multimodal image embeddings via Voyage `voyage-multimodal-3`** — today the image upload pipeline embeds the companion markdown note's text (description + OCR + tags), so semantic search works on the description. But the image pixels themselves are never embedded, so "find an image that looks visually similar to this one" doesn't work. Swap (or add alongside) the embed step to use `voyage-multimodal-3`, which accepts interleaved text + image and returns 1024-dim vectors in a unified space. Store multimodal vectors in a distinct column or table so hybrid search can blend or separate them. Enables: (1) "find images that look like this photo" via image upload as query, (2) strict text-only or image-only modes, (3) better cross-modal retrieval when a text query matches an image's visual content (not just its description). Needs: DB migration for new vector storage, update to hybrid-search.ts, cost estimate (multimodal is more expensive per call), decision on whether to keep text embeddings alongside or replace.

---

## Shaped

### Growth Prompting Heartbeat

**Problem:** Grove's graph has gaps — orphan notes, thin concepts, disconnected islands, unstated tensions — but nothing proactively surfaces them. Without a rhythm, gaps compound silently. Daily interactive use pulls new content in but doesn't cycle attention back to what's already in the vault.

**Sketch:**
- Daily cron (~7am local) scans graph state for **mechanical signals**: orphan notes, thin concepts (<100 words, no outbound links), islands (2+ disconnected components), stale notes with unresolved TODOs. Signals ranked by impact.
- Separately, a **random-walk pass** samples N short walks through the wikilink graph; an LLM reads each walk and looks for latent patterns — implicit questions, unstated super-categories, unnamed tensions between concepts. Produces "thoughtful" prompts beyond mechanical gap-filling.
- Top 3 prompts go into a morning **email digest**: 1–2 mechanical + 1 thoughtful. Silent-day fallback when the graph is genuinely healthy.
- Answer routing: narrow prompts (e.g., "Alice has no backlinks") edit the triggering note directly. Broad prompts (essay-shaped, reflective) append to today's journal entry. User chooses mode per reply.

**Dependencies:**
- Email infra (exists: `src/email.ts`, Phase B)
- Graph health metrics (exists: Phase 13)
- LLM access for walk synthesis + prompt polishing (likely Claude Haiku, same as Phase 7 discovery)
- Shared pipeline with "Extract learnings from autonomous runs" — both emit a daily email with human-attention items (possible convergence into one unified "Grove heartbeat" digest)

**Success signal:** After 30 days, graph health metrics (orphans, islands, thin concepts) trend down. Daily prompt email produces 1–2 vault edits or journal entries per week on average. Silent-day rate feels correct (neither every day nor never). Random-walk prompts surface at least one "I hadn't thought of that" insight per week.

**Open questions:**
- Unified "Grove daily heartbeat" email (growth prompts + cron learnings combined) vs. two separate streams?
- Random-walk cost: N walks/day, which model, what's the budget?
- Reply-to-email → vault write plumbing: forward-to-grove address, IMAP poll, or link back to dashboard-answer surface?
- "Reject this prompt" feedback loop so heartbeat learns what's signal vs. noise — built in from the start, or add when needed?

---

### Extract Learnings from Autonomous Runs

**Problem:** Cron jobs (`post-sync-discover`, auto-healer, graph-health, eval loops) make decisions, surface anomalies, and encounter failures — but those observations evaporate. The same issues re-surface and next agent sessions don't benefit from prior findings. Some anomalies generate genuine questions for the human, with no routing path today.

**Sketch:**
- `LEARNINGS.md` at repo root, append-only, checked into git.
- Each cron run appends a terse section `## <ISO-date> <run-name>` with:
  - `Observed:` anomalies, drift, repairs made
  - `Acted:` auto-resolutions taken
  - `Asks:` questions for the human (rolls into the daily heartbeat email)
- CLAUDE.md references `LEARNINGS.md` so agent sessions load recent findings at startup — no re-diagnosing problems an earlier run already solved.
- Weekly pulse (`/garden:pulse` or a new `/garden:learnings`) summarizes the week's entries; patterns worth keeping graduate to vault concept notes or PLAN.md tasks.

**Dependencies:**
- Existing cron surfaces: `post-sync-discover.sh`, Phase 13 auto-healer, Phase 13 graph-health
- Shared email digest with Growth Prompting Heartbeat (the "Asks" section is a direct input to that email)
- CLAUDE.md reference pattern (standard, works today)

**Success signal:** After 2 weeks, a fresh Claude Code session in `grove/` cites prior learnings without prompting (e.g., "per last week's LEARNINGS, the auto-healer already normalized broken wikilinks after move X"). Human answers the daily "Asks" section occasionally — indicating the filter surfaces genuinely ambiguous signals, not noise. File stays under a size cap (30-day inline window, older archived).

**Open questions:**
- Rigid template (easier to parse, drifts to boilerplate) vs. free-form bullets (higher quality, harder to summarize)?
- Size cap: when to rotate `LEARNINGS.md` into `LEARNINGS/2026-Q2.md` archives? 30 days? 200 lines?
- Dedup: if two crons observe the same anomaly, does it write twice, or increment a `seen: N` counter on the existing entry?
- Single email vs. separate from growth-prompting heartbeat — same question from both shapings; resolve together.

---

### Core Product Capacities List

**Problem:** Grove's actual capabilities, its marketing copy, its docs, and its PLAN.md drift apart. The landing page advertises things that exist but aren't discoverable; features ship without updating docs; agents connecting via MCP have no canonical answer to "what can Grove do?". Three audiences — humans (marketing), agents (introspection), internal (roadmap) — need the same data from one source.

**Sketch:**
- `capacities.yml` at repo root, source of truth. Example entry:
  ```yaml
  - id: semantic-search
    name: Semantic search across your vault
    description: Hybrid BM25 + vector search; returns notes ranked by relevance
    status: shipped       # shipped | beta | planned
    implemented_by: [Phase 0, Phase 5]
    primitives: [mcp:query, rest:/v1/search]
    docs: docs/search.md
    marketing_anchor: /features#search
  ```
- Scope is **product-level capabilities** (user outcomes), not API primitives. Primitives are listed per-capability for agents that want to drill down.
- Build step generates:
  - `docs/capabilities.md` — human-readable Markdown (rendered in docs + pulled into grove-www)
  - `grove-www/public/.well-known/grove-capacities.json` — machine-readable manifest for agents
  - Landing page section at `grove.md/features` hydrates from the generated Markdown
- CI check: every `status: shipped` capability must reference a ✅ phase in PLAN.md; every ✅ phase should map to at least one capability. Drift fails the build.

**Dependencies:**
- PLAN.md (unchanged — phases stay authoritative; capabilities link outward via `implemented_by`)
- grove-www build pipeline (small generator step — YAML → Markdown + JSON)
- Possible `vault_status?mode=capabilities` MCP response (stays under the 6-tool limit)

**Success signal:** A new user hitting `grove.md/features` and an agent fetching `/.well-known/grove-capacities.json` get the same 8–15 capabilities, accurate to what's shipped. Every phase-graduating PR includes a capacities.yml update; CI rejects PRs that ship a new capability without updating the manifest. Marketing copy on the landing page is grep-able back to YAML IDs.

**Open questions:**
- YAML vs. JSON as source (YAML easier to hand-edit; generate JSON). Confirming YAML is the right choice.
- Agent introspection: extend `vault_status` with a `mode: capabilities` parameter, or expose a separate `/.well-known/` endpoint only? (Architecture rule in CLAUDE.md: keep MCP tools at 6. Strong lean toward the /.well-known/ endpoint unless there's a reason agents can't fetch HTTP.)
- Granularity rule: one line of marketing copy = one capability? Or finer?
- `beta` status: can a capability be listed as beta without any fully-shipped phase reference? (Probably yes — beta = partial shipment; CI rule is "shipped requires shipped phase", looser for beta.)

---

## Ready

<!-- Fully shaped ideas waiting to be moved into PLAN.md -->

---

## Graduated

Ideas that have been spec'd and moved into PLAN.md.

- **Encryption at Rest** → Phase 12
- **User Profile & Trail Config UX** → Phase 15
- **Graph Health Heartbeats** → Phase 13
- **Image Uploads as Graph Nodes** → Phase 14
- **Pinterest-Style Image View** → Phase 14
- **Vault-Agnostic Structure** → Phase 10
- **DELETE/Move Endpoint** → Phase 11
- **Multi-resident URL structure** → Phase 16
- **Post-login lands at grove.md/dashboard** → Phase 17
- **Mobile-optimized pages** → Phase 18
