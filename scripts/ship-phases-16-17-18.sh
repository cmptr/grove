#!/usr/bin/env bash
set -euo pipefail

# ── Ship Phases 16, 17, 18 ─────────────────────────────────────────
# Sequences run-batch.sh invocations for Phases 16 (multi-resident URL),
# 17 (post-login redirect), 18 (mobile-optimized pages). After each batch,
# marks the completed task IDs in PLAN.md and pushes to origin.
#
# run-batch.sh does NOT push to origin or touch PLAN.md — it only merges
# locally and runs tests. This driver closes the stewardship loop so the
# work lands on origin/main with an accurate PLAN.md.
#
# Exits on first batch failure so the broken state is diagnosable.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

DATE=$(date +%Y-%m-%d)

log() { echo "[$(date +%H:%M:%S)] $*"; }

# Portable in-place sed (macOS uses BSD sed which requires a backup suffix arg).
sed_i() {
  local expr="$1"
  local file="$2"
  sed -i.bak "$expr" "$file"
  rm -f "${file}.bak"
}

mark_complete() {
  # Usage: mark_complete <PLAN-TASK-ID> <SHORT-SHA>
  local task="$1"
  local sha="$2"
  # Skip if already marked
  if grep -qE "^#### ${task}:.*✅" PLAN.md; then
    log "  PLAN.md: ${task} already marked ✅ — skipping"
    return 0
  fi
  # Append the completion marker to the #### heading
  # The heading line format is: #### <task>: <description>
  sed_i "s|^\(#### ${task}:.*\)$|\1 ✅ COMPLETE ${DATE} (${sha})|" PLAN.md
  if grep -qE "^#### ${task}:.*✅ COMPLETE ${DATE} \(${sha}\)" PLAN.md; then
    log "  PLAN.md: marked ${task} ✅ COMPLETE"
  else
    log "  WARNING: could not mark ${task} in PLAN.md (heading pattern missed?)"
  fi
}

run_wave() {
  # Usage: run_wave <batch-name> <task-id...>
  local batch="$1"
  shift
  local tasks=("$@")

  log ""
  log "════════════════════════════════════════════"
  log " Batch: ${batch}"
  log " Tasks: ${tasks[*]}"
  log "════════════════════════════════════════════"

  # Run the batch (agents → merge → test). Fails → set -e stops us.
  ./scripts/run-batch.sh "${batch}"

  # Capture the new HEAD sha (merge commit of the batch)
  local sha
  sha=$(git log -1 --format="%h")
  log "Batch ${batch} merged at ${sha}"

  # Update PLAN.md for every task this batch completed
  for task in "${tasks[@]}"; do
    mark_complete "${task}" "${sha}"
  done

  # Commit PLAN.md if it changed
  if ! git diff --quiet PLAN.md; then
    git add PLAN.md
    git commit -m "plan: mark ${batch} tasks complete (${tasks[*]})

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
    log "PLAN.md update committed."
  else
    log "PLAN.md already up to date for ${batch}."
  fi

  # Push to origin so worktree agents in the next batch see a fresh base
  git push origin main
  log "Pushed ${batch} to origin/main."
  log ""
}

# ── Pre-flight ─────────────────────────────────────────────────────
log "Pre-flight: confirming working tree is clean"
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "ERROR: working tree has uncommitted changes. Commit or stash first."
  git status --short
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "${CURRENT_BRANCH}" != "main" ]]; then
  log "ERROR: not on main (on ${CURRENT_BRANCH}). Switch to main first."
  exit 1
fi

# Make sure local main matches origin/main
git fetch origin main --quiet
LOCAL=$(git rev-parse main)
REMOTE=$(git rev-parse origin/main)
if [[ "${LOCAL}" != "${REMOTE}" ]]; then
  log "ERROR: local main (${LOCAL:0:7}) != origin/main (${REMOTE:0:7})"
  log "  Push local commits or pull remote changes first."
  exit 1
fi

log "Working tree clean, on main, synced with origin. Ready to ship."

# ── Execute waves ──────────────────────────────────────────────────

START=$(date +%s)

# Wave 1: foundation for P16 + independent phases
run_wave "p16-1" "P16-1"

# Wave 2: independent phase (no p16 dependency)
run_wave "p17" "P17-1" "P17-2" "P17-3" "P17-4"

# Wave 3: independent phase
run_wave "p18" "P18-1" "P18-2" "P18-3" "P18-4" "P18-5"

# Wave 4: scoped routes + URL builders (parallel agents, depends on p16-1)
run_wave "p16-2" "P16-2" "P16-4"

# Wave 5: legacy redirects + handle editor (parallel agents, depends on p16-2)
run_wave "p16-3" "P16-3" "P16-5"

# Wave 6: e2e integration test (depends on p16-3)
run_wave "p16-4" "P16-6"

# ── Final verification ─────────────────────────────────────────────

log ""
log "════════════════════════════════════════════"
log " All 6 batches shipped — running final checks"
log "════════════════════════════════════════════"

log "Typecheck..."
npx tsc --noEmit

log "Full test suite..."
npm test

log "Plan-drift check (local)..."
npm run check:plan || true  # informational — there are no PR commits to check

ELAPSED=$(( $(date +%s) - START ))
MINS=$(( ELAPSED / 60 ))
log ""
log "✅ DONE — Phases 16, 17, 18 shipped in ${MINS} min."
log "   Final commit: $(git log -1 --format='%h %s')"
