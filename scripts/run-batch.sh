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

ALL_BATCHES="p4-prereq p4b-1 rest cli-a cli-b p5-tag p7-1 p7-2 p7-3 p9-1 p9-2 p9-3"

get_batch() {
  ENTRIES=()
  case "$1" in
    p4-prereq)
      ENTRIES+=("agent/p4-prereq|Read PLAN.md tasks P4-PREREQ-1 and P4-PREREQ-2. Implement both per spec. Run npm test before committing.")
      ;;
    p4b-1)
      ENTRIES+=("agent/p4-api-4|Read PLAN.md task P4-API-4. Add git status to vault stats per spec. Run npm test before committing.")
      ENTRIES+=("agent/p4-api-3|Read PLAN.md task P4-API-3. Fix /keys list and /metrics per spec. Run npm test before committing.")
      ENTRIES+=("agent/p4-api-1|Read PLAN.md task P4-API-1. Implement trail CRUD HTTP endpoints per spec. Run npm test before committing.")
      ENTRIES+=("agent/p4-api-2|Read PLAN.md task P4-API-2. Implement user list endpoint and fix last_login_at per spec. Run npm test before committing.")
      ;;
    rest)
      ENTRIES+=("agent/rest-write|Read PLAN.md tasks REST-1 and REST-2. Extract handleWriteNote and add PUT /v1/notes/:path per spec. Run npm test before committing.")
      ENTRIES+=("agent/rest-status|Read PLAN.md task REST-3. Add GET /v1/status/:mode endpoints per spec. Run npm test before committing.")
      ;;
    cli-a)
      ENTRIES+=("agent/cli-json|Read PLAN.md tasks CLI-A1, CLI-A2, and REST-4. Refactor CLI: add --json global flag, semantic exit codes, and migrate from MCP to REST HTTP calls. Run npm test before committing.")
      ENTRIES+=("agent/cli-commands|Read PLAN.md tasks CLI-A3 through CLI-A7. Add --content flag on write, grove init with env var overrides, promote graph and digest to top-level commands, add grove health and grove metrics commands, add help text with output schemas. Run npm test before committing.")
      ;;
    cli-b)
      ENTRIES+=("agent/cli-consistency|Read PLAN.md tasks CLI-B1 through CLI-B4. Move trails from local SQLite to HTTP, add --paths flag, add --if-hash on write, add grove whoami. Run npm test before committing.")
      ;;
    p5-tag)
      ENTRIES+=("agent/p5-tag|Read PLAN.md tasks P5-TAG-1 and P5-TAG-2. Implement auto-tagging on write and tag-backfill CLI command per spec. Run npm test before committing.")
      ;;
    p7-1)
      ENTRIES+=("agent/p7-discovery-loop|Read PLAN.md task P7-1. Build the discovery loop skeleton per spec. Run npm test before committing.")
      ENTRIES+=("agent/p7-ingest|Read PLAN.md task P7-7. Build the grove ingest command per spec. Run npm test before committing.")
      ;;
    p7-2)
      ENTRIES+=("agent/p7-extraction|Read PLAN.md tasks P7-2 and P7-3. Build concept extraction via Claude API and wikilink wiring per spec. Run npm test before committing.")
      ENTRIES+=("agent/p7-neighbors|Read PLAN.md task P7-4. Build semantic neighbor surfacing per spec. Run npm test before committing.")
      ;;
    p7-3)
      ENTRIES+=("agent/p7-digest|Read PLAN.md task P7-5. Add discovery mode to vault_status per spec. Run npm test before committing.")
      ENTRIES+=("agent/p7-bookmarks|Read PLAN.md tasks P7-6 and P7-8. Build bookmark integration and post-ingest bootstrap per spec. Run npm test before committing.")
      ;;
    p9-1)
      ENTRIES+=("agent/p9-roles|Read PLAN.md task P9-1. Add user roles per spec. Run npm test before committing.")
      ENTRIES+=("agent/p9-invite|Read PLAN.md task P9-2. Build invite flow per spec. Run npm test before committing.")
      ENTRIES+=("agent/p9-scoped-keys|Read PLAN.md task P9-3. Scope keys to users per spec. Run npm test before committing.")
      ;;
    p9-2)
      ENTRIES+=("agent/p9-user-ui|Read PLAN.md task P9-4. Build user management dashboard page per spec. Run npm test before committing.")
      ENTRIES+=("agent/p9-trail-sharing|Read PLAN.md tasks P9-5 and P9-6. Build trail sharing pages per spec. Run npm test before committing.")
      ;;
    p9-3)
      ENTRIES+=("agent/p9-share|Read PLAN.md task P9-7. Build share-a-note links per spec. Run npm test before committing.")
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

PIDS=()
LOGFILES=()
for i in "${!BRANCHES[@]}"; do
  branch="${BRANCHES[$i]}"
  prompt="${PROMPTS[$i]}"
  logfile="$LOG_DIR/${BATCH}_${branch//\//_}_${TIMESTAMP}.log"

  log "Launching agent $((i+1))/$AGENT_COUNT: $branch"

  # Launch claude in worktree mode, backgrounded.
  # Use `script` to allocate a PTY so output streams unbuffered
  # and `tail -f` on the logfile works in real-time.
  script -q "$logfile" claude --worktree --print "$prompt" &
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
      status="⏳"
    else
      status="✓"
    fi

    # Get log size (human-readable)
    size="0"
    if [[ -f "$logfile" ]]; then
      size=$(du -h "$logfile" 2>/dev/null | cut -f1 | tr -d ' ')
    fi

    # Get last meaningful line (strip control codes, blanks)
    last=""
    if [[ -f "$logfile" ]]; then
      last=$(cat "$logfile" 2>/dev/null | col -b 2>/dev/null | sed 's/^[[:space:]]*//' | grep -v '^$' | tail -1 | cut -c1-80)
    fi

    echo "  $status $branch  ($size)  ${last:-<starting...>}"
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

# ── Merge branches ────────────────────────────────────────────────

log "Starting merge sequence..."
git checkout main

for branch in "${BRANCHES[@]}"; do
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
for branch in "${BRANCHES[@]}"; do
  # Find and remove worktree for this branch
  worktree=$(git worktree list --porcelain 2>/dev/null | grep -B2 "branch refs/heads/$branch" | head -1 | sed 's/worktree //' || true)
  if [[ -n "$worktree" && "$worktree" != "$REPO_DIR" ]]; then
    git worktree remove "$worktree" --force 2>/dev/null || true
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
