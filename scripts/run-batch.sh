#!/usr/bin/env bash
set -euo pipefail

# ── Grove Batch Runner ────────────────────────────────────────────
# Launches parallel claude agents, waits for all to finish,
# merges branches in order, runs tests, reports results.
#
# Usage:
#   ./scripts/run-batch.sh <batch-name>
#   ./scripts/run-batch.sh --list
#
# Examples:
#   ./scripts/run-batch.sh p4-prereq
#   ./scripts/run-batch.sh p4b-1
#   ./scripts/run-batch.sh cli-a
#   ./scripts/run-batch.sh p7-1

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$REPO_DIR/.agents"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# ── Batch Definitions ─────────────────────────────────────────────
# Each batch is a function that populates ENTRIES array.
# Format: "branch|prompt" per entry.
# Agents within a batch run in parallel.
# Merge order = definition order (first defined = first merged).

ALL_BATCHES="p4-prereq p4b-1 rest cli-a cli-b p5-tag p7-1 p7-2 p7-3 p9-1 p9-2 p9-3 p10-1 p10-2 p11-1 p11-2 p12-1 p12-2 p13-1 p13-2 p14-1 p14-2 p15-1 p15-2 p16-1 p16-2 p16-3 p16-4 p17 p18 p19-1 p19-2 p19-3 p19-4"

get_batch() {
  ENTRIES=()
  case "$1" in
    p4-prereq)
      ENTRIES+=("p4-prereq|Read PLAN.md tasks P4-PREREQ-1 and P4-PREREQ-2. Implement both per spec. Run npm test before committing.")
      ;;
    p4b-1)
      ENTRIES+=("p4-api-4|Read PLAN.md task P4-API-4. Add git status to vault stats per spec. Run npm test before committing.")
      ENTRIES+=("p4-api-3|Read PLAN.md task P4-API-3. Fix /keys list and /metrics per spec. Run npm test before committing.")
      ENTRIES+=("p4-api-1|Read PLAN.md task P4-API-1. Implement trail CRUD HTTP endpoints per spec. Run npm test before committing.")
      ENTRIES+=("p4-api-2|Read PLAN.md task P4-API-2. Implement user list endpoint and fix last_login_at per spec. Run npm test before committing.")
      ;;
    rest)
      ENTRIES+=("rest-write|Read PLAN.md tasks REST-1 and REST-2. Extract handleWriteNote and add PUT /v1/notes/:path per spec. Run npm test before committing.")
      ENTRIES+=("rest-status|Read PLAN.md task REST-3. Add GET /v1/status/:mode endpoints per spec. Run npm test before committing.")
      ;;
    cli-a)
      ENTRIES+=("cli-json|Read PLAN.md tasks CLI-A1, CLI-A2, and REST-4. Refactor CLI: add --json global flag, semantic exit codes, and migrate from MCP to REST HTTP calls. Run npm test before committing.")
      ENTRIES+=("cli-commands|Read PLAN.md tasks CLI-A3 through CLI-A7. Add --content flag on write, grove init with env var overrides, promote graph and digest to top-level commands, add grove health and grove metrics commands, add help text with output schemas. Run npm test before committing.")
      ;;
    cli-b)
      ENTRIES+=("cli-consistency|Read PLAN.md tasks CLI-B1 through CLI-B4. Move trails from local SQLite to HTTP, add --paths flag, add --if-hash on write, add grove whoami. Run npm test before committing.")
      ;;
    p5-tag)
      ENTRIES+=("p5-tag|Read PLAN.md tasks P5-TAG-1 and P5-TAG-2. Implement auto-tagging on write and tag-backfill CLI command per spec. Run npm test before committing.")
      ;;
    p7-1)
      ENTRIES+=("p7-discovery-loop|Read PLAN.md task P7-1. Build the discovery loop skeleton per spec. Run npm test before committing.")
      ENTRIES+=("p7-ingest|Read PLAN.md task P7-7. Build the grove ingest command per spec. Run npm test before committing.")
      ;;
    p7-2)
      ENTRIES+=("p7-extraction|Read PLAN.md tasks P7-2 and P7-3. Build concept extraction via Claude API and wikilink wiring per spec. Run npm test before committing.")
      ENTRIES+=("p7-neighbors|Read PLAN.md task P7-4. Build semantic neighbor surfacing per spec. Run npm test before committing.")
      ;;
    p7-3)
      ENTRIES+=("p7-digest|Read PLAN.md task P7-5. Add discovery mode to vault_status per spec. Run npm test before committing.")
      ENTRIES+=("p7-bookmarks|Read PLAN.md tasks P7-6 and P7-8. Build bookmark integration and post-ingest bootstrap per spec. Run npm test before committing.")
      ;;
    p9-1)
      ENTRIES+=("p9-roles|Read PLAN.md task P9-1. Add user roles per spec. Run npm test before committing.")
      ENTRIES+=("p9-invite|Read PLAN.md task P9-2. Build invite flow per spec. Run npm test before committing.")
      ENTRIES+=("p9-scoped-keys|Read PLAN.md task P9-3. Scope keys to users per spec. Run npm test before committing.")
      ;;
    p9-2)
      ENTRIES+=("p9-user-ui|Read PLAN.md task P9-4. Build user management dashboard page per spec. Run npm test before committing.")
      ENTRIES+=("p9-trail-sharing|Read PLAN.md tasks P9-5 and P9-6. Build trail sharing pages per spec. Run npm test before committing.")
      ;;
    p9-3)
      ENTRIES+=("p9-share|Read PLAN.md task P9-7. Build share-a-note links per spec. Run npm test before committing.")
      ;;

    # ── Phase 10: Vault-Agnostic Structure ──
    p10-1)
      ENTRIES+=("p10-config|Read PLAN.md tasks P10-1 and P10-5. Create vault config module with schema, loading, defaults, and auto-detection per spec. Run npm test before committing.")
      ENTRIES+=("p10-validate|Read PLAN.md task P10-2. Decouple notes-validate.ts from hard-coded PARA paths per spec. Run npm test before committing.")
      ;;
    p10-2)
      ENTRIES+=("p10-discovery|Read PLAN.md task P10-3. Decouple discovery-extract.ts, discovery-link.ts, discovery-bookmarks.ts, db.ts, server.ts, rest.ts, and cli.ts from PARA paths per spec. Run npm test before committing.")
      ENTRIES+=("p10-stats|Read PLAN.md task P10-4. Decouple vault-stats.ts from PARA paths per spec. Run npm test before committing.")
      ENTRIES+=("p10-cli|Read PLAN.md task P10-6. Add grove config CLI command per spec. Run npm test before committing.")
      ;;

    # ── Phase 11: Note Lifecycle (DELETE/Move) ──
    p11-1)
      ENTRIES+=("p11-lifecycle|Read PLAN.md tasks P11-1 and P11-2. Implement DELETE and PATCH (move) endpoints per spec. Run npm test before committing.")
      ENTRIES+=("p11-cli|Read PLAN.md task P11-4. Add grove delete and grove move CLI commands per spec. Run npm test before committing.")
      ;;
    p11-2)
      ENTRIES+=("p11-mcp|Read PLAN.md task P11-3. Extend write_note MCP tool with delete/move actions per spec. Run npm test before committing.")
      ;;

    # ── Phase 12: Encryption at Rest ──
    p12-1)
      ENTRIES+=("p12-crypto|Read PLAN.md tasks P12-1 and P12-2. Build encryption module and vault key lifecycle per spec. Run npm test before committing.")
      ENTRIES+=("p12-cli|Read PLAN.md task P12-5. Add vault encrypt/unlock/lock CLI commands per spec. Run npm test before committing.")
      ;;
    p12-2)
      ENTRIES+=("p12-vault-encrypt|Read PLAN.md task P12-3. Add transparent encryption to vault-ops per spec. Run npm test before committing.")
      ENTRIES+=("p12-index-encrypt|Read PLAN.md task P12-4. Encrypt search index per spec. Run npm test before committing.")
      ;;

    # ── Phase 13: Graph Health & Auto-Healing ──
    p13-1)
      ENTRIES+=("p13-metrics|Read PLAN.md tasks P13-1 and P13-2. Build graph health metrics, scoring, and automated monitoring per spec. Run npm test before committing.")
      ENTRIES+=("p13-api|Read PLAN.md task P13-4. Add health REST API endpoints per spec. Run npm test before committing.")
      ;;
    p13-2)
      ENTRIES+=("p13-autohealer|Read PLAN.md task P13-3. Build graph auto-healing logic per spec. Run npm test before committing.")
      ENTRIES+=("p13-dashboard|Read PLAN.md task P13-4 frontend. Build health dashboard page in grove-www per spec. Run npm test before committing.")
      ;;

    # ── Phase 14: Image System ──
    p14-1)
      ENTRIES+=("p14-storage|Read PLAN.md tasks P14-1 and P14-2. Build R2 storage client and image upload endpoint per spec. Run npm test before committing.")
      ENTRIES+=("p14-search|Read PLAN.md task P14-3. Add image metadata to search results per spec. Run npm test before committing.")
      ;;
    p14-2)
      ENTRIES+=("p14-pinterest|Read PLAN.md task P14-4. Build Pinterest-style image view in grove-www per spec. Run npm test before committing.")
      ;;

    # ── Phase 15: Profile & Settings UX ──
    p15-1)
      ENTRIES+=("p15-profile|Read PLAN.md task P15-1. Build user profile page with backend API per spec. Run npm test before committing.")
      ENTRIES+=("p15-trail-editor|Read PLAN.md task P15-2. Build visual trail scope editor per spec. Run npm test before committing.")
      ;;
    p15-2)
      ENTRIES+=("p15-nonowner|Read PLAN.md task P15-3. Build non-owner dashboard experience per spec. Run npm test before committing.")
      ;;

    # ── Phase 16: Multi-Resident URL Structure ──
    # IMPORTANT: every prompt ends with an explicit commit step. Agents
    # running in --print mode have silently exited without committing
    # before, and `git worktree remove --force` then destroyed the work.
    p16-1)
      ENTRIES+=("p16-handle-model|Read PLAN.md task P16-1. Add handle model, handle_history table, validation, reserved-word list, /v1/residents/:handle endpoint, bio column, and migration per spec. Run npm test — all tests must pass. THEN run: git add -A && git reset HEAD .claude && git commit -m 'feat(P16-1): handle model + handle_history + /v1/residents/:handle'. Verify the commit exists with git log -1 before exiting. DO NOT EXIT WITHOUT COMMITTING.")
      ;;
    p16-2)
      ENTRIES+=("p16-scoped-routes|Read PLAN.md task P16-2. Build scoped route scaffold at grove-www/src/app/(resident)/[atHandle]/* including public profile, scoped share viewer, scoped trail page, and auth-gated note viewer per spec. Run any existing tests. THEN commit: git add -A && git reset HEAD .claude && git commit -m 'feat(P16-2): scoped /@<handle>/* routes'. Verify with git log -1 before exiting. DO NOT EXIT WITHOUT COMMITTING.")
      ENTRIES+=("p16-url-builders|Read PLAN.md task P16-4. Update URL builders in src/share.ts, src/rest.ts, src/invite.ts, src/email.ts to emit /@<handle>/... canonical URLs per spec. Update existing tests and docs/api.md. Run npm test — all tests must pass. THEN commit: git add -A && git reset HEAD .claude && git commit -m 'feat(P16-4): URL builders emit /@<handle>/... canonical URLs'. Verify with git log -1 before exiting. DO NOT EXIT WITHOUT COMMITTING.")
      ;;
    p16-3)
      ENTRIES+=("p16-legacy-redirects|Read PLAN.md task P16-3. Convert legacy pages (/s/[id], /trails/[slug], /[...path]) in grove-www to 301 redirect shims to /@<handle>/... canonical URLs per spec. Run any tests. THEN commit: git add -A && git reset HEAD .claude && git commit -m 'feat(P16-3): 301 redirects from legacy paths to /@<handle>/*'. Verify with git log -1 before exiting. DO NOT EXIT WITHOUT COMMITTING.")
      ENTRIES+=("p16-handle-editor|Read PLAN.md task P16-5. Build handle editor in grove-www profile page + PATCH /v1/me backend support for handle + bio changes with handle_history writes and audit log per spec. Run npm test — all tests must pass. THEN commit: git add -A && git reset HEAD .claude && git commit -m 'feat(P16-5): handle + bio editor in profile; PATCH /v1/me accepts handle/bio'. Verify with git log -1 before exiting. DO NOT EXIT WITHOUT COMMITTING.")
      ;;
    p16-4)
      ENTRIES+=("p16-e2e|Read PLAN.md task P16-6. Write end-to-end Playwright integration test at grove-www/test/multi-resident.e2e.spec.ts covering the five-step golden path per spec. Install @playwright/test if grove-www/package.json doesn't have it yet and add test:e2e script. Run the new test locally to confirm it passes. THEN commit: git add -A && git reset HEAD .claude && git commit -m 'test(P16-6): multi-resident e2e golden path'. Verify with git log -1 before exiting. DO NOT EXIT WITHOUT COMMITTING.")
      ;;

    # ── Phase 17: Post-Login Redirect ──
    p17)
      ENTRIES+=("p17-redirect|Read PLAN.md tasks P17-1, P17-2, P17-3, P17-4. Fix callback redirect by role, make marketing root and /login auth-aware, and add e2e integration test per spec. All changes in grove-www. Run any tests. THEN commit: git add -A && git reset HEAD .claude && git commit -m 'feat(P17): post-login redirect — callback + marketing + /login + e2e'. Verify with git log -1 before exiting. DO NOT EXIT WITHOUT COMMITTING.")
      ;;

    # ── Phase 18: Mobile-Optimized Pages ──
    p18)
      ENTRIES+=("p18-mobile|Read PLAN.md tasks P18-1 through P18-5. Add viewport meta + global safety net, fix identified hot spots (usage grid, note-view max-width, code blocks, Mermaid), add Playwright mobile regression test at grove-www/test/mobile.spec.ts with npm run test:mobile script, complete full audit pass, and update README. Install @playwright/test if needed. Run npm run test:mobile to confirm it passes. THEN commit: git add -A && git reset HEAD .claude && git commit -m 'feat(P18): mobile baseline at 375px + Playwright regression'. Verify with git log -1 before exiting. DO NOT EXIT WITHOUT COMMITTING.")
      ;;

    # ── Phase 19: Note Share UI ──
    p19-1)
      ENTRIES+=("p19-schema|Read PLAN.md task P19-1 and SPEC.md sections B1+B2. Add schema migration (table rebuild for nullable max_views + revoked_by + revoked_at + last_accessed_at columns, idempotent) and extend src/share.ts with new signatures (createShareLink accepts max_views: null, listShareLinks with note_path/include_expired filters, new revokeShareLink, resolveShareLink updates last_accessed_at) per spec. Run npm test. THEN commit: git add -A && git reset HEAD .claude && git commit -m 'feat(P19-1): share schema migration + share.ts extensions'. Verify with git log -1 before exiting. DO NOT EXIT WITHOUT COMMITTING.")
      ;;
    p19-2)
      ENTRIES+=("p19-backend|Read PLAN.md task P19-2 and SPEC.md sections B3+B4+B5+B6+B7. Add GET /v1/admin/share and DELETE /v1/admin/share/:id endpoints, extend POST to accept null max_views, return 410 on expired/revoked public resolves, add rate limits (20/hr mint per owner key, 60/min public view per IP), update docs/api.md. Run npm test. THEN commit: git add -A && git reset HEAD .claude && git commit -m 'feat(P19-2): share list/revoke endpoints + rate limits + 410'. Verify with git log -1 before exiting. DO NOT EXIT WITHOUT COMMITTING.")
      ;;
    p19-3)
      ENTRIES+=("p19-proxy|Read PLAN.md tasks P19-3 and P19-6 and SPEC.md sections F5+F6. In grove-www add/extend /api/admin/share proxy routes (GET+POST+DELETE) with Origin-header CSRF check on mutating routes, verify SameSite=Strict session cookie; and update (resident)/[atHandle]/s/[id]/page.tsx to render 410 expired/revoked page with noindex metadata. Run tests. THEN commit: git add -A && git reset HEAD .claude && git commit -m 'feat(P19-3,P19-6): share proxy routes + CSRF + 410 recipient page'. Verify with git log -1 before exiting. DO NOT EXIT WITHOUT COMMITTING.")
      ENTRIES+=("p19-share-ui|Read PLAN.md task P19-4 and SPEC.md sections F1+F2+F3. In grove-www add ShareButton and ShareModal components (modal lazy-loaded via next/dynamic ssr:false), integrate into note-view.tsx (owner-only, role passed from route), presets-only form (TTL 24h/7d/30d, Max 10/100/Unlimited), responsive bottom-sheet<640px/centered>=640px, auto-copy with clipboard-fallback, full a11y (ARIA dialog, focus trap, aria-live copy announcement). Run tests including npm run test:mobile. THEN commit: git add -A && git reset HEAD .claude && git commit -m 'feat(P19-4): share button + modal on note-view'. Verify with git log -1 before exiting. DO NOT EXIT WITHOUT COMMITTING.")
      ;;
    p19-4)
      ENTRIES+=("p19-dashboard|Read PLAN.md task P19-5 and SPEC.md section F4. In grove-www add /dashboard/shares page (server) + SharesTable client component: fetch include_expired=true, single table with muted expired rows, columns Note/Link/Status/Created/Expires/Views/Actions, client-side search by note_path, sort by created_at, inline-confirm revoke with optimistic update + rollback, empty-state one-liner, add Shares nav item (owner-only). Run tests including npm run test:mobile. THEN commit: git add -A && git reset HEAD .claude && git commit -m 'feat(P19-5): dashboard shares management page'. Verify with git log -1 before exiting. DO NOT EXIT WITHOUT COMMITTING.")
      ;;

    *)
      return 1
      ;;
  esac
}

# ── Helpers ───────────────────────────────────────────────────────

list_batches() {
  echo "Available batches:"
  echo ""
  for batch in $ALL_BATCHES; do
    get_batch "$batch"
    echo "  $batch  (${#ENTRIES[@]} agents)"
  done
  echo ""
  echo "Execution order:"
  echo "  p4-prereq → p4b-1 → rest → cli-a → cli-b"
  echo "  p5-tag (independent, anytime)"
  echo "  p7-1 → p7-2 → p7-3"
  echo "  p9-1 → p9-2 → p9-3"
  echo "  p10-1 → p10-2 (vault-agnostic)"
  echo "  p11-1 → p11-2 (delete/move, after p10)"
  echo "  p12-1 → p12-2 (encryption, independent)"
  echo "  p13-1 → p13-2 (graph health, after p7 + p11)"
  echo "  p14-1 → p14-2 (images, independent)"
  echo "  p15-1 → p15-2 (profile UX, after p9)"
  echo "  p16-1 → p16-2 → p16-3 → p16-4 (multi-resident URL, after p15)"
  echo "  p17 (post-login redirect, independent)"
  echo "  p18 (mobile-optimized pages, independent)"
  echo "  p19-1 → p19-2 → p19-3 → p19-4 (note share UI, after p9-7 + p16 + p18)"
}

log() {
  echo "[$(date +%H:%M:%S)] $*"
}

# ── Main ──────────────────────────────────────────────────────────

if [[ "${1:-}" == "--list" || "${1:-}" == "-l" ]]; then
  list_batches
  exit 0
fi

BATCH="${1:-}"
if [[ -z "$BATCH" ]] || ! get_batch "$BATCH" 2>/dev/null; then
  echo "Usage: ./scripts/run-batch.sh <batch-name>"
  echo "       ./scripts/run-batch.sh --list"
  [[ -n "$BATCH" ]] && echo "Unknown batch: $BATCH"
  exit 1
fi

get_batch "$BATCH"

cd "$REPO_DIR"
mkdir -p "$LOG_DIR"

# ── Pre-flight: push to origin ──────────────────────────────────
# claude --worktree branches from origin/main, not local main.
# Unpushed commits mean agents work on a stale base → merge conflicts.
ahead=$(git log origin/main..main --oneline 2>/dev/null | wc -l | tr -d ' ')
if [[ "$ahead" -gt 0 ]]; then
  log "Pushing $ahead commit(s) to origin/main (worktrees branch from origin)..."
  git push origin main || { log "Push failed — fix and retry."; exit 1; }
fi

# Parse batch definition into arrays
BRANCHES=()
PROMPTS=()
for entry in "${ENTRIES[@]}"; do
  branch="${entry%%|*}"
  prompt="${entry#*|}"
  BRANCHES+=("$branch")
  PROMPTS+=("$prompt")
done

AGENT_COUNT=${#BRANCHES[@]}
log "Starting batch '$BATCH' with $AGENT_COUNT agent(s)"
log "Branches: ${BRANCHES[*]}"
echo ""

# ── Launch agents ─────────────────────────────────────────────────

START_TIME=$(date +%s)
PIDS=()
LOGFILES=()
for i in "${!BRANCHES[@]}"; do
  branch="${BRANCHES[$i]}"
  prompt="${PROMPTS[$i]}"
  logfile="$LOG_DIR/${BATCH}_${branch//\//_}_${TIMESTAMP}.log"

  log "Launching agent $((i+1))/$AGENT_COUNT: $branch"

  # Launch claude in worktree mode, backgrounded.
  # Output is buffered (appears when agent finishes), but the progress
  # monitor below polls log file sizes to show liveness.
  claude --worktree "$branch" --print --dangerously-skip-permissions "$prompt" > "$logfile" 2>&1 &
  PIDS+=($!)
  LOGFILES+=("$logfile")
done

echo ""
log "All $AGENT_COUNT agents launched."
echo ""

# ── Progress monitor while waiting ───────────────────────────────
# Reports log size + last meaningful line per agent every 30s.

progress() {
  for i in "${!BRANCHES[@]}"; do
    branch="${BRANCHES[$i]}"
    pid="${PIDS[$i]}"
    logfile="${LOGFILES[$i]}"

    # Check if still running
    if kill -0 "$pid" 2>/dev/null; then
      status="⏳ running"
    else
      wait "$pid" 2>/dev/null && status="✅ done" || status="❌ failed"
    fi

    # Get log size
    size="0B"
    if [[ -f "$logfile" ]]; then
      bytes=$(wc -c < "$logfile" 2>/dev/null | tr -d ' ')
      if [[ "$bytes" -gt 1048576 ]]; then
        size="$((bytes / 1048576))MB"
      elif [[ "$bytes" -gt 1024 ]]; then
        size="$((bytes / 1024))KB"
      else
        size="${bytes}B"
      fi
    fi

    # Check worktree git activity for this agent's branch
    detail=""
    # claude --worktree "<name>" creates worktree at .claude/worktrees/<name>/
    # Branch names like "agent/p4-prereq" become directory "agent+p4-prereq" or similar
    for wt_dir in "$REPO_DIR"/.claude/worktrees/*/; do
      [[ -d "$wt_dir" ]] || continue
      wt_branch=$(git -C "$wt_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
      # Match this worktree to this agent's branch (check if branch name is contained)
      case "$wt_branch" in *"${branch##*/}"*|*"${branch//\//-}"*|*"${branch//\//.}"*)
        commits=$(git -C "$wt_dir" log --oneline main..HEAD 2>/dev/null | wc -l | tr -d ' ')
        if [[ "$commits" -gt 0 ]]; then
          last_msg=$(git -C "$wt_dir" log -1 --format="%s" 2>/dev/null | cut -c1-60)
          detail="$commits commit(s): $last_msg"
        else
          changed=$(git -C "$wt_dir" diff --stat 2>/dev/null | tail -1 | tr -d ' ')
          if [[ -n "$changed" ]]; then
            detail="editing: $changed"
          else
            detail="worktree created"
          fi
        fi
        break
        ;;
      esac
    done

    # Elapsed time for this agent
    now=$(date +%s)
    elapsed=$(( now - START_TIME ))
    mins=$(( elapsed / 60 ))
    secs=$(( elapsed % 60 ))

    echo "  $status  ${mins}m${secs}s  log:${size}  ${detail:-<starting...>}"
  done
}

# Poll progress while any agent is alive
while true; do
  # Check if any PID is still running
  any_alive=false
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      any_alive=true
      break
    fi
  done
  $any_alive || break

  log "── Progress ──"
  progress
  echo ""

  # Sleep 30s but break early if all agents finish
  for tick in $(seq 1 30); do
    any_alive=false
    for pid in "${PIDS[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        any_alive=true
        break
      fi
    done
    $any_alive || break
    sleep 1
  done
done

# ── Collect exit codes ───────────────────────────────────────────

FAILED=()
for i in "${!PIDS[@]}"; do
  pid="${PIDS[$i]}"
  branch="${BRANCHES[$i]}"

  if wait "$pid"; then
    log "✓ Agent $branch completed (PID $pid)"
  else
    log "✗ Agent $branch FAILED (PID $pid, exit $?)"
    FAILED+=("$branch")
  fi
done

log "── Final Status ──"
progress

echo ""

if [[ ${#FAILED[@]} -gt 0 ]]; then
  log "BATCH INCOMPLETE — ${#FAILED[@]} agent(s) failed: ${FAILED[*]}"
  log "Check logs in $LOG_DIR/"
  log "Fix issues and re-run, or merge successful branches manually."
  exit 1
fi

log "All agents completed successfully."
echo ""

# ── Auto-commit safety net ────────────────────────────────────────
# Agents running in `claude --print` mode sometimes finish their work,
# run tests, and exit WITHOUT committing. The next `git worktree remove
# --force` would then destroy the uncommitted changes. Catch that here:
# any worktree with uncommitted (but non-.claude) work gets auto-committed.

for name in "${BRANCHES[@]}"; do
  wt_dir="$REPO_DIR/.claude/worktrees/$name"
  [[ -d "$wt_dir" ]] || continue

  # Detect uncommitted work: staged, unstaged, or untracked (excluding .claude/)
  tracked_dirty=false
  if ! git -C "$wt_dir" diff --quiet || ! git -C "$wt_dir" diff --cached --quiet; then
    tracked_dirty=true
  fi
  untracked=$(git -C "$wt_dir" ls-files --others --exclude-standard 2>/dev/null | grep -vE "^\.claude/" || true)

  if $tracked_dirty || [[ -n "$untracked" ]]; then
    log "⚠ Worktree $name has uncommitted changes — auto-committing (agent exited without committing)"
    git -C "$wt_dir" add -A
    # Unstage .claude/ (claude CLI writes session artifacts there)
    git -C "$wt_dir" reset -q HEAD -- .claude 2>/dev/null || true
    git -C "$wt_dir" commit -m "auto: run-batch safety-net commit for $name

Agent completed without committing. Files staged automatically.
Review the contents before relying on this commit." || log "  (nothing committable after excluding .claude/)"
  fi
done

echo ""

# ── Merge branches ────────────────────────────────────────────────

log "Starting merge sequence..."
git checkout main

for name in "${BRANCHES[@]}"; do
  # claude --worktree "<name>" creates branch "worktree-<name>"
  branch="worktree-$name"

  # Check if branch exists and has commits ahead of main
  if ! git rev-parse --verify "$branch" >/dev/null 2>&1; then
    log "⚠ Branch $branch not found — agent may not have committed. Skipping."
    continue
  fi

  ahead=$(git log main.."$branch" --oneline 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$ahead" -eq 0 ]]; then
    log "⚠ Branch $branch has no commits ahead of main. Skipping."
    continue
  fi

  log "Merging $branch ($ahead commits)..."
  if git merge "$branch" --no-edit; then
    log "✓ Merged $branch"
  else
    log "✗ MERGE CONFLICT on $branch"
    log "  Resolve manually, then run: git merge --continue"
    log "  Remaining branches: ${BRANCHES[*]}"
    exit 1
  fi
done

echo ""

# ── Verify ────────────────────────────────────────────────────────

log "Running tests on merged main..."
if npm test; then
  log "✓ All tests pass"
else
  log "✗ TESTS FAILED after merge"
  log "  Fix issues or revert: git reset --hard HEAD~${#BRANCHES[@]}"
  exit 1
fi

echo ""

# ── Clean up worktrees ────────────────────────────────────────────

log "Cleaning up worktrees..."
for name in "${BRANCHES[@]}"; do
  branch="worktree-$name"
  # Remove worktree directory
  wt_dir="$REPO_DIR/.claude/worktrees/$name"
  if [[ -d "$wt_dir" ]]; then
    git worktree remove "$wt_dir" --force 2>/dev/null || true
  fi
  # Delete the branch
  git branch -d "$branch" 2>/dev/null || true
done

echo ""

# ── Summary ───────────────────────────────────────────────────────

log "═══════════════════════════════════════════"
log "Batch '$BATCH' complete."
log "$AGENT_COUNT agents → merged → tests pass"
log "═══════════════════════════════════════════"
log ""
log "Next steps:"
log "  Deploy: ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231 'cd /root/grove && git pull && npm ci --production && sudo pm2 restart grove-server grove-proxy'"
log "  Or trigger GitHub Actions deploy manually."
