# Grove — GOAL.md

> Make the best personal knowledge API on the internet.

## Fitness Function

```bash
bash scripts/score.sh        # human-readable
bash scripts/score.sh --json # machine-readable
```

**Mode: Split** — The agent can improve measurement scripts and add new checks, but cannot change the component weights or point allocations defined below.

### Components (150 points total)

| Component | Points | What it measures |
|-----------|--------|------------------|
| **Reliability** | 35 | Tests pass, error messages are helpful, no silent failures, git ops recover gracefully |
| **Search Quality** | 25 | Hybrid search returns relevant results, BM25+vec fusion works, edge cases handled |
| **Code Quality** | 30 | Test coverage by module, no `any` types, no swallowed errors, consistent patterns |
| **Developer Experience** | 30 | Setup works, CLI is complete, docs are accurate, deploy is smooth |
| **Flexibility** | 30 | Validation doesn't block reasonable requests, vault structure isn't over-prescribed |

### Scoring Details

**Reliability (35 pts)**
- All tests pass: 10 pts
- Every `catch` block either logs or re-throws (no empty catches): 5 pts
- Error messages include actionable context (not just "invalid"): 5 pts
- Git operations handle branch/remote detection (not hardcoded `origin/main`): 5 pts
- Write queue recovers from failures without corrupting state: 5 pts
- QMD reindex failures don't block writes: 5 pts

**Search Quality (25 pts)**
- Vec search fallback when TEI is down: 5 pts
- BM25 search works independently: 5 pts
- Fuzzy path resolution covers common patterns: 5 pts
- Search handles empty/malformed queries gracefully: 5 pts
- RRF weights are configurable (env vars or config): 5 pts

**Code Quality (30 pts)**
- Test files exist for every src module with >50 lines: 10 pts (1 pt per module)
- No `as any` casts: 5 pts
- Frontmatter parsing uses a real YAML parser (not regex): 5 pts
- Consistent error handling pattern across modules: 5 pts
- No hardcoded paths that assume specific OS/install: 5 pts

**Developer Experience (30 pts)**
- README has working setup instructions: 5 pts
- `grove status` works against live server: 5 pts
- CLI covers all 6 MCP tools: 5 pts
- CLI has `--help` for every command: 5 pts
- Deploy process documented and works in <5 commands: 5 pts
- First-time setup from clone to running takes <10 min: 5 pts

**Flexibility (30 pts)**
- Any type string accepted in validation: 5 pts
- Tags not forced to match type: 5 pts
- Path enforcement only blocks cross-type conflicts: 5 pts
- write_note description matches actual validation behavior: 5 pts
- Lifecycle classification covers all vault folders: 5 pts
- CLI write accepts custom tags: 5 pts

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

Append one JSON line per iteration to `iterations.jsonl`:

```json
{"ts":"2026-04-07T12:00:00Z","before":{"total":85,"reliability":25,"search":15,"code":20,"dx":15,"flexibility":10},"after":{"total":92,"reliability":25,"search":15,"code":27,"dx":15,"flexibility":10},"action":"add tests for vault-ops and embed-single","component":"code","delta":7}
```

---

## Action Catalog

Prioritized by estimated impact. Work top-down.

### Reliability (+35 potential)
| Action | Est. pts | Effort |
|--------|----------|--------|
| Replace hardcoded `origin/main` with detected upstream | +5 | 30 min |
| Add recovery logging to every catch block in proxy.ts | +5 | 20 min |
| Make error messages include fix suggestions | +5 | 30 min |
| Add QMD health check before reindex (skip gracefully if down) | +5 | 15 min |

### Search Quality (+25 potential)
| Action | Est. pts | Effort |
|--------|----------|--------|
| Add env vars for RRF weights (BM25_WEIGHT, VEC_WEIGHT) | +5 | 10 min |
| Graceful BM25-only fallback when TEI is unreachable | +5 | 20 min |
| Add search edge case tests (empty query, special chars) | +5 | 20 min |

### Code Quality (+30 potential)
| Action | Est. pts | Effort |
|--------|----------|--------|
| Add test files for vault-ops, vault-graph, proxy, cli, hybrid-search, embed | +10 | 2 hr |
| Replace regex YAML parsing in vault-ops with `yaml` library | +5 | 20 min |
| Audit and remove all `as any` casts | +5 | 30 min |
| Standardize error handling (throw typed errors, never swallow) | +5 | 1 hr |

### Developer Experience (+30 potential)
| Action | Est. pts | Effort |
|--------|----------|--------|
| Add --help to every CLI command | +5 | 30 min |
| Write setup guide (clone → running in <10 min) | +5 | 30 min |
| Ensure README setup section is current and tested | +5 | 20 min |

### Flexibility (+30 potential)
| Action | Est. pts | Effort |
|--------|----------|--------|
| Most flexibility items already done in today's session | ~25 | done |
| Remaining: verify lifecycle covers all folders end-to-end | +5 | 15 min |

---

## Operating Mode

**Continuous** — This is a passion project. The agent should keep iterating as long as there are actions with positive expected value. When score approaches 140+, shift to finding new dimensions to measure.

---

## Constraints

1. **Never break the MCP protocol.** Claude.ai connects as a custom connector. If response shape changes, every connected surface breaks.
2. **Never add MCP tools beyond 6** without explicit approval. More tools = worse agent tool selection.
3. **Never write to the vault outside the write queue.** Concurrent git = corruption.
4. **Keep dependencies minimal.** Don't add packages for things Node can do natively. No web frameworks.
5. **All tests must pass before committing.** No `--no-verify`.
6. **Don't refactor working code just for style.** If it works and has tests, leave it alone unless the score says otherwise.
7. **Don't change PLAN.md phases or success criteria.** This file defines what to improve, not what to build.
