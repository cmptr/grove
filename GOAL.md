# Grove — GOAL.md

> Your knowledge, everywhere your AI is. Shaped for every audience.

Grove is a hosted knowledge API over a personal Obsidian vault. Phase 1 built the foundation — 6 MCP tools, hybrid search, git-backed writes, 150/150 on infrastructure quality. Now it becomes something bigger: a system where knowledge grows autonomously and can be selectively shared through **groves** — topic-scoped windows into your knowledge, enforced server-side.

## Fitness Function

```bash
bash scripts/score.sh        # human-readable
bash scripts/score.sh --json # machine-readable
```

**Mode: Split** — Agents can improve measurement scripts and add new checks, but cannot change component weights or point allocations.

### Components (150 points total)

| Component | Points | What it measures |
|-----------|--------|------------------|
| **Groves** | 30 | Shared knowledge spaces work — CRUD, LLM-as-judge filtering, scope enforcement, evals pass |
| **Discovery** | 30 | Background loop grows the concept graph autonomously — extracts, links, surfaces, respects limits |
| **Onboarding** | 20 | Bulk ingest works — folder in, structured vault out, deduplicates, extracts concepts |
| **Safety** | 30 | Judge evals >95% precision, snapshots/rollback work, blast radius enforced, full audit trail |
| **Foundation** | 40 | Tests pass, no regressions, infrastructure scorecard holds (reliability, search, code quality, DX, flexibility) |

---

### Scoring Details

**Groves (30 pts)** — Shared knowledge spaces

A grove is: a name + topic instructions (allow/deny) + permission level (search/read/write) + API key. The LLM judge runs server-side on the VPS, filtering every response before it reaches the consumer.

- Grove CRUD works (`grove create`, `grove list`, `grove revoke`): 5 pts
- Grove config stored and loaded (`~/.grove/groves.json`): 3 pts
- LLM-as-judge filters responses for grove keys: 5 pts
- Judge blocks sensitive content in eval suite (>95% precision): 5 pts
- Judge allows on-topic content in eval suite (>90% recall): 4 pts
- Permission levels enforced (search-only can't read full notes, read can't write): 4 pts
- Consumer can connect their Claude to a grove via MCP endpoint: 4 pts

**Discovery (30 pts)** — Autonomous knowledge growth

A background loop on the VPS that watches for new/changed notes and grows the concept graph without human invocation.

- Background process runs and watches for changes: 5 pts
- Extracts new concepts from changed notes: 5 pts
- Creates concept notes that don't exist yet: 5 pts
- Wires wikilinks between related notes: 5 pts
- Surfaces surprising connections (semantic neighbors): 3 pts
- Respects blast radius limit (max N notes per run): 4 pts
- Git-tag snapshot before each run: 3 pts

**Onboarding (20 pts)** — Cold start / bulk ingest

Point at a folder, get a structured vault.

- `grove ingest <dir>` reads files from a directory: 5 pts
- Parses markdown frontmatter and content: 3 pts
- Deduplicates against existing vault (by title, content hash): 4 pts
- Extracts concepts and creates initial graph: 5 pts
- Handles non-markdown files gracefully (skip or convert): 3 pts

**Safety (30 pts)** — Trust infrastructure

The foundation that makes groves and discovery trustworthy.

- Judge eval suite exists with labeled test cases: 5 pts
- Eval precision >95% (doesn't leak sensitive notes): 5 pts
- Eval recall >90% (doesn't over-block on-topic content): 5 pts
- `grove rollback <tag>` reverts to a snapshot: 5 pts
- Blast radius limit configurable and enforced: 4 pts
- Audit log records every autonomous action with reasoning: 3 pts
- Rate limits per grove (writes/hour): 3 pts

**Foundation (40 pts)** — No regressions

The infrastructure scorecard from the previous GOAL.md, sampled:

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
{"ts":"2026-04-07T18:00:00Z","before":{"total":40,"groves":0,"discovery":0,"onboarding":0,"safety":0,"foundation":40},"after":{"total":52,"groves":12,"discovery":0,"onboarding":0,"safety":0,"foundation":40},"action":"grove CRUD and config storage","component":"groves","delta":12}
```

---

## Action Catalog

Prioritized by impact. **Ship Groves first** — it's the most differentiated feature and unlocks sharing.

### Groves (+30 potential)
| Action | Est. pts | Effort |
|--------|----------|--------|
| Grove config schema (`~/.grove/groves.json`) + CRUD CLI | +8 | 2 hr |
| Wire grove key to proxy — inject topic instructions into request context | +5 | 2 hr |
| LLM-as-judge filter layer — local model on VPS evaluates each response | +5 | 4 hr |
| Permission level enforcement (search/read/write gates in proxy) | +4 | 2 hr |
| Grove-specific MCP endpoint (consumer connects their Claude to your grove) | +4 | 2 hr |
| Judge eval suite — labeled test cases, precision/recall measurement | +4 | 3 hr |

### Safety (+30 potential)
| Action | Est. pts | Effort |
|--------|----------|--------|
| Judge eval suite with labeled sensitive/safe notes | +10 | 3 hr |
| `grove rollback <tag>` — revert vault to a git tag | +5 | 1 hr |
| Blast radius config — max notes per background run | +4 | 30 min |
| Audit log for autonomous actions | +3 | 1 hr |
| Per-grove rate limits | +3 | 30 min |

### Discovery (+30 potential)
| Action | Est. pts | Effort |
|--------|----------|--------|
| Background watcher process (triggered by git commits / write_note) | +5 | 3 hr |
| Concept extraction from note content (entity recognition) | +5 | 4 hr |
| Auto-create concept notes + wire wikilinks | +5 | 2 hr |
| Semantic neighbor surfacing (embedding similarity) | +3 | 2 hr |
| Git-tag snapshot before each run | +3 | 30 min |
| Blast radius enforcement in loop | +4 | 30 min |
| Discovery digest in vault_status | +5 | 1 hr |

### Onboarding (+20 potential)
| Action | Est. pts | Effort |
|--------|----------|--------|
| `grove ingest <dir>` — read + parse directory of files | +8 | 2 hr |
| Deduplication against existing vault | +4 | 1 hr |
| Concept extraction from ingested content | +5 | 2 hr |
| Non-markdown file handling (skip with warning) | +3 | 30 min |

### Foundation (+40 potential)
| Action | Est. pts | Effort |
|--------|----------|--------|
| Maintain existing test suite and code quality | +40 | ongoing |

---

## Operating Mode

**Continuous** — with a bias toward shipping Groves first. The priority order:

1. **Groves** — the most shareable, differentiated feature
2. **Safety** — required before groves can be trusted
3. **Discovery** — the autonomous growth loop
4. **Onboarding** — cold start for new content
5. **Foundation** — maintain, don't regress

---

## Constraints

1. **Never break the MCP protocol.** Claude.ai connects as a custom connector. If response shape changes, every connected surface breaks.
2. **Never add MCP tools beyond 6** without explicit approval. More tools = worse agent tool selection. New capabilities compose from existing tools.
3. **Never write to the vault outside the write queue.** Concurrent git = corruption.
4. **Keep dependencies minimal.** No web frameworks. No heavy ML libraries on VPS — use TEI and small local models.
5. **All tests must pass before committing.** No `--no-verify`.
6. **Grove filtering must be server-side.** Never trust the consumer's client to respect topic boundaries.
7. **Background discovery has a blast radius limit.** Default max 10 notes per run. Configurable but never unlimited.
8. **Every autonomous write gets a git-tag snapshot.** Rollback must always be possible.
9. **The vault is sacred.** Grove is plumbing. Discovery is a gardener. Neither is the owner.

---

## What Happened to the Garden Skills

The garden-* skills in `~/.claude/skills/` were training wheels for when Grove was new and needed explicit workflows. As Grove matured, John stopped invoking them individually — he just talks to Grove and it figures out what to do.

| Skill | Fate |
|-------|------|
| `/garden` | **Stays** — daily practice ritual, powered by discovery digest |
| `/garden-wander` | **Stays** — serendipity requires a human in the loop |
| `/garden-seek` | Absorbed — natural `query` tool use in conversation |
| `/garden-plant` | Absorbed — natural `write_note` tool use in conversation |
| `/garden-harvest` | Absorbed into background discovery loop |
| `/garden-forage` | Absorbed into background discovery loop |
| `/garden-tend` | Absorbed into background discovery loop |

Skills that remain should be updated to consume discovery data rather than doing the discovery themselves.
