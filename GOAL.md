# Grove — GOAL.md

> Your knowledge, everywhere your AI is. Shaped for every audience.

Grove is a hosted knowledge API over a personal Obsidian vault. Phases 0-1 built the foundation — 6 MCP tools, hybrid search, git-backed writes, full infrastructure scorecard. Now we harden it, make it observable, give it a face, and open it up through **trails** — topic-scoped paths through the grove, server-side filtered.

## Fitness Function

```bash
bash scripts/score.sh        # human-readable
bash scripts/score.sh --json # machine-readable
```

**Mode: Split** — Agents can improve measurement scripts and add new checks, but cannot change component weights or point allocations.

### Components (175 points total)

| Component | Points | What it measures |
|-----------|--------|------------------|
| **Security** | 30 | Exploitable gaps closed — path traversal, CORS, body limits, scope enforcement, encryption, backups |
| **Observability** | 30 | Full visibility — structured logs, correlation IDs, health checks, metrics, alerting |
| **Portal** | 25 | Web dashboard — admin auth, key management, usage metrics, vault health |
| **Trails** | 50 | Scoped sharing works — config, filtering, eval passes, audit, consumer can connect |
| **Foundation** | 40 | No regressions — tests pass, code quality, coverage, CLI, docs |

---

### Scoring Details

**Security (30 pts)** — Close every exploitable gap

- Path traversal guard rejects `..` and symlinks outside vault: 5 pts
- CORS locked to explicit allowed origins (not `*`): 3 pts
- Request body size limit enforced (1MB cap, 413 on oversize): 3 pts
- Key scopes enforced (read-only key gets 403 on write): 4 pts
- EBS volume encrypted: 3 pts
- Daily S3 backup running: 3 pts
- No plaintext secrets in JSON files (OAuth secrets in env vars): 4 pts
- Key TTLs — `expires_at` in schema, expired keys rejected: 5 pts

**Observability (30 pts)** — Full visibility into system health

- Structured JSON logs to stdout with required fields (ts, rid, tool, key_id, status, duration_ms): 5 pts
- Request correlation IDs (ULID) through proxy → server: 4 pts
- Read audit log exists (key identity on every read): 3 pts
- Deep health check — `/health` verifies QMD + embed server: 5 pts
- `/metrics` endpoint returns request counts, latency percentiles, error rates: 5 pts
- BetterStack uptime monitor pinging `/health` every 60s: 4 pts
- Dead man's switch — daily cron heartbeat to BetterStack: 4 pts

**Portal (25 pts)** — Web dashboard on api.grove.md

- Admin auth works (admin key → session cookie with TTL): 5 pts
- Key management UI (list, create, revoke): 6 pts
- Usage dashboard (request volume, latency, errors over time): 6 pts
- Vault health panel (note count, sync status, embedding coverage, index health): 5 pts
- Dashboard loads without errors, serves from same server: 3 pts

**Trails (50 pts)** — Topic-scoped sharing

A trail is: a name + topic boundaries (tags, types, paths) + permission level + API key. Consumers connect via MCP and see only what the trail allows.

- Trail CRUD works (`grove trails create`, `list`, `disable`, `delete`): 5 pts
- Trail config stored and loaded (`~/.grove/trails.json`): 3 pts
- Trail resolution in proxy (key → trail lookup, pass context to server): 4 pts
- Tag/type/path prefilter implemented in server: 6 pts
- `query` returns `filtered_count` in responses: 3 pts
- `get`/`multi_get` return 404 (not 403) for hidden notes: 3 pts
- `list_notes` only returns trail-visible notes: 3 pts
- `write_note` constrains writes to trail scope: 3 pts
- `vault_status` returns scoped stats for trail keys: 2 pts
- Trail info in MCP `initialize` handshake: 3 pts
- Trail filter eval — precision >95% on labeled dataset: 5 pts
- Trail filter eval — recall >90% on labeled dataset: 4 pts
- Trail audit log records every access with filtered/allowed counts: 3 pts
- Per-trail rate limits enforced: 3 pts

**Foundation (40 pts)** — No regressions

- All tests pass: 10 pts
- No empty catch blocks or `as any` casts: 5 pts
- Every src module >50 lines has tests: 5 pts
- Git ops use dynamic branch detection: 5 pts
- Error messages have actionable context: 5 pts
- CLI covers all operations with --help: 5 pts
- README and deploy docs are current: 5 pts

---

## Improvement Loop

```
1. Run scripts/score.sh --json
2. Identify the lowest-scoring component
3. Read the specific checks that failed
4. Pick the highest-impact action from the catalog
5. Implement the fix
6. Re-run scripts/score.sh --json
7. If score improved: commit with "grove: <component> <score_before>→<score_after>"
8. If score regressed: revert
9. Append to iterations.jsonl
10. Repeat
```

### Iteration Log

```json
{"ts":"2026-04-07T22:00:00Z","before":{"total":40,"security":0,"observability":0,"portal":0,"trails":0,"foundation":40},"after":{"total":40,"security":0,"observability":0,"portal":0,"trails":0,"foundation":40},"action":"baseline","component":"foundation","delta":0}
```

---

## Action Catalog

Prioritized by phase order. **Security first** — close exploitable gaps before building new surfaces.

### Security (+30 potential)
| Action | Est. pts | Effort | Phase task |
|--------|----------|--------|------------|
| Path traversal guard in server.ts | +5 | 1 hr | P2-1 |
| CORS lockdown to explicit origins | +3 | 30 min | P2-2 |
| Request body size limit (1MB) | +3 | 30 min | P2-3 |
| Enforce key scopes in proxy | +4 | 1 hr | P2-4 |
| EBS volume encryption | +3 | 1 hr | P2-5 |
| Daily S3 backup cron | +3 | 1 hr | P2-6 |
| Move OAuth secrets to env vars | +4 | 30 min | P2-7 |
| Key TTLs (expires_at + rejection) | +5 | 2 hr | P2-8 |

### Observability (+30 potential)
| Action | Est. pts | Effort | Phase task |
|--------|----------|--------|------------|
| Structured JSON logging + correlation IDs | +9 | 3 hr | P3-1, P3-2 |
| Read audit log | +3 | 1 hr | P3-3 |
| Deep health check (verify downstream) | +5 | 1 hr | P3-4 |
| `/metrics` endpoint with counters | +5 | 2 hr | P3-5 |
| BetterStack integration + alerting | +8 | 2 hr | P3-6 |

### Portal (+25 potential)
| Action | Est. pts | Effort | Phase task |
|--------|----------|--------|------------|
| Admin auth (key → session cookie) | +5 | 2 hr | P4-1 |
| Key management UI | +6 | 3 hr | P4-2 |
| Usage dashboard | +6 | 3 hr | P4-3 |
| Vault health panel | +5 | 2 hr | P4-4 |
| Dashboard serving + styling | +3 | 1 hr | P4-1 |

### Trails (+50 potential)
| Action | Est. pts | Effort | Phase task |
|--------|----------|--------|------------|
| Trail config schema + CRUD CLI | +8 | 3 hr | P5-1, P5-2 |
| Trail resolution in proxy | +4 | 2 hr | P5-3 |
| Server-side tag/type/path prefilter | +6 | 4 hr | P5-4 |
| Tool behavior under trail keys (404, scoped list, filtered_count) | +14 | 4 hr | P5-5, P5-6 + tool changes |
| Trail info in MCP handshake | +3 | 1 hr | P5-6 |
| Trail filter eval suite | +9 | 3 hr | P5-8 |
| Trail audit log + rate limits | +6 | 2 hr | P5-9, P5-10 |

### Foundation (+40 potential)
| Action | Est. pts | Effort | Phase task |
|--------|----------|--------|------------|
| Maintain existing test suite and code quality | +40 | ongoing | — |

---

## Operating Mode

**Continuous** — with strict phase ordering. Each phase gates the next:

1. **Security** (Phase 2) — close exploitable gaps first
2. **Observability** (Phase 3) — see what's happening before building new surfaces
3. **Portal** (Phase 4) — management surface for everything that follows
4. **Trails** (Phase 5) — the core differentiating feature
5. **Foundation** — maintain throughout, never regress

**Stopping condition:** 160/175 (allows some aspirational items to remain open).

---

## Constraints

1. **Never break the MCP protocol.** Claude.ai connects as a custom connector. If response shape changes, every connected surface breaks.
2. **Never add MCP tools beyond 6** without explicit approval. More tools = worse agent tool selection. New capabilities compose from existing tools.
3. **Never write to the vault outside the write queue.** Concurrent git = corruption.
4. **Keep dependencies minimal.** No web frameworks. No heavy ML libraries on VPS — use TEI and small local models.
5. **All tests must pass before committing.** No `--no-verify`.
6. **Trail filtering must be server-side.** Never trust the consumer's client to respect topic boundaries.
7. **Hidden notes return 404, not 403.** Never leak note existence to trail consumers.
8. **Security fixes before new features.** Don't build on top of exploitable gaps.
9. **The vault is sacred.** Grove is plumbing. Trails are windows. Neither is the owner.

---

## Future Phases (not scored yet)

These will get their own scoring components when the current phases are complete:

- **Phase 6: LLM Judge** — Ollama + Qwen2.5-3B for semantic trail filtering. Deferred until tag/type/path prefilter proves insufficient.
- **Phase 7: Discovery** — Background loop grows the concept graph autonomously. Requires local LLM from Phase 6.
- **Phase 8: Multi-Vault** — Additional vaults (work vault) as separate queryable indexes.
