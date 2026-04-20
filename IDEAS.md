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
- **Extract learnings from autonomous runs** — systematically capture what autonomous Grove/agent runs discover so lessons compound instead of evaporating
- **Core product capacities list** — canonical list of Grove's capabilities, kept consistent across docs, marketing, and product surfaces
- **Open source calibration** — decide what's the right amount of Grove to open-source (SDK? proxy? nothing? everything minus hosted infra?)
- **Extract design system** — pull a coherent design system out of the current Grove UI so future surfaces stay visually consistent
- **SOC2 baseline** — SSO, encryption at rest/transit, access logs, no prod access without MFA — the minimum surface to be SOC2-ready
- **Mobile-optimized pages** — fix pages that have horizontal scroll outside the viewport on mobile
- **Multimodal image embeddings via Voyage `voyage-multimodal-3`** — today the image upload pipeline embeds the companion markdown note's text (description + OCR + tags), so semantic search works on the description. But the image pixels themselves are never embedded, so "find an image that looks visually similar to this one" doesn't work. Swap (or add alongside) the embed step to use `voyage-multimodal-3`, which accepts interleaved text + image and returns 1024-dim vectors in a unified space. Store multimodal vectors in a distinct column or table so hybrid search can blend or separate them. Enables: (1) "find images that look like this photo" via image upload as query, (2) strict text-only or image-only modes, (3) better cross-modal retrieval when a text query matches an image's visual content (not just its description). Needs: DB migration for new vector storage, update to hybrid-search.ts, cost estimate (multimodal is more expensive per call), decision on whether to keep text embeddings alongside or replace.
- **Multi-resident URL structure** — today every route on grove.md is single-tenant (the vault is implicitly mine). Before onboarding any other user we need a URL shape that scopes to a resident — `/u/<handle>/…` or `grove.md/<handle>/…` or a subdomain — and threads the resident through routing, auth, sharing, and the API surface. Also affects deep links shared externally, OG images, and the `/profile`/`/home`/`/images` paths that currently assume "you". Decide the shape before we have v2 users with live links we'd have to migrate.

---

## Shaped

<!-- Ideas that have been discussed and have a rough shape -->

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
