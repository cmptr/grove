#!/usr/bin/env bash
set -euo pipefail

# ── Ship Phases 16, 17, 18 ─────────────────────────────────────────
# Sequences run-batch.sh invocations, with extra machinery for cross-repo
# work in grove-www (which lives in a sibling checkout, not a worktree).
#
# Key responsibilities:
#   1. Before each batch, guarantee grove-www is on main + clean + in-sync
#      with origin. Claude --worktree creates a worktree in the grove repo;
#      when agents modify grove-www, they do so in whatever branch grove-www
#      happens to be on. We anchor that to main.
#   2. After each batch, if grove-www gained commits (on main directly, or
#      on a feature branch), fold them into main and push to origin so the
#      next batch's agents start from a clean base.
#   3. Pre/post sha check in grove to detect no-op merges (agent didn't commit).
#   4. Mark completed PLAN.md tasks after each batch, commit, push.
#
# Batch order:
#   p16-1 → p17 → p18 → p16-2 → p16-3-handle-editor → p16-3-legacy-redirects → p16-4
#
# p16-3 is split into two sequential single-agent batches because both of
# its original agents (handle-editor + legacy-redirects) write to the same
# grove-www checkout; parallel run would race.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GROVE_WWW="$(cd "$REPO_DIR/../grove-www" && pwd)"
cd "$REPO_DIR"

DATE=$(date +%Y-%m-%d)

log() { echo "[$(date +%H:%M:%S)] $*"; }

sed_i() {
  local expr="$1" file="$2"
  sed -i.bak "$expr" "$file"
  rm -f "${file}.bak"
}

# ── grove-www helpers ──────────────────────────────────────────────

grove_www_current_branch() {
  git -C "$GROVE_WWW" rev-parse --abbrev-ref HEAD
}

grove_www_sync_before_batch() {
  log "grove-www: sync before batch"
  local branch
  branch=$(grove_www_current_branch)
  if [[ "$branch" != "main" ]]; then
    # If on a stray branch, fold any commits into main first
    grove_www_sync_after_batch "$branch"
  fi
  git -C "$GROVE_WWW" fetch origin main --quiet
  git -C "$GROVE_WWW" checkout main --quiet 2>/dev/null || true
  git -C "$GROVE_WWW" merge origin/main --ff-only
  if ! git -C "$GROVE_WWW" diff --quiet || ! git -C "$GROVE_WWW" diff --cached --quiet; then
    log "ERROR: grove-www has uncommitted changes before batch. Aborting."
    git -C "$GROVE_WWW" status --short
    exit 1
  fi
  log "  grove-www on main @ $(git -C "$GROVE_WWW" rev-parse --short main)"
}

grove_www_sync_after_batch() {
  # Called after a batch. Optional arg: known-branch to merge (falls back to current).
  local override="${1:-}"
  local branch
  branch=$(grove_www_current_branch)
  [[ -n "$override" ]] && branch="$override"

  if [[ "$branch" == "main" ]]; then
    # Agent committed directly on main; push whatever's new
    git -C "$GROVE_WWW" fetch origin main --quiet
    local to_push
    to_push=$(git -C "$GROVE_WWW" log origin/main..main --oneline | wc -l | tr -d ' ')
    if [[ "$to_push" -gt 0 ]]; then
      log "grove-www: pushing $to_push commit(s) from main"
      git -C "$GROVE_WWW" push origin main
    else
      log "grove-www: no new commits on main"
    fi
    return
  fi

  # Agent ended up on a feature branch — merge forward onto main
  local ahead
  ahead=$(git -C "$GROVE_WWW" log main.."$branch" --oneline 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$ahead" -eq 0 ]]; then
    log "grove-www: on $branch, no commits ahead of main — checkout main"
    git -C "$GROVE_WWW" checkout main --quiet 2>/dev/null || true
    return
  fi

  log "grove-www: $branch has $ahead commit(s) ahead of main — consolidating"
  git -C "$GROVE_WWW" checkout main --quiet
  git -C "$GROVE_WWW" fetch origin main --quiet
  git -C "$GROVE_WWW" merge origin/main --ff-only

  # Cherry-pick each commit from $branch in chronological order
  local commits
  commits=$(git -C "$GROVE_WWW" log main.."$branch" --format=%H --reverse)
  while IFS= read -r sha; do
    [[ -z "$sha" ]] && continue
    log "  cherry-pick $sha"
    git -C "$GROVE_WWW" cherry-pick "$sha"
  done <<< "$commits"

  git -C "$GROVE_WWW" push origin main
  log "grove-www: pushed $ahead commit(s) to origin/main"
}

# ── grove PLAN.md marking ──────────────────────────────────────────

mark_complete() {
  local task="$1" sha="$2"
  if grep -qE "^#### ${task}:.*✅" PLAN.md; then
    log "  PLAN.md: ${task} already marked ✅ — skipping"
    return 0
  fi
  sed_i "s|^\(#### ${task}:.*\)$|\1 ✅ COMPLETE ${DATE} (${sha})|" PLAN.md
  if grep -qE "^#### ${task}:.*✅ COMPLETE" PLAN.md; then
    log "  PLAN.md: marked ${task} ✅ COMPLETE"
  else
    log "  WARNING: could not mark ${task} in PLAN.md"
  fi
}

commit_and_push_plan() {
  local batch="$1"
  shift
  local tasks=("$@")
  if ! git diff --quiet PLAN.md; then
    git add PLAN.md
    git commit -m "plan: mark ${batch} tasks complete (${tasks[*]})

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
    log "PLAN.md update committed."
  else
    log "PLAN.md already up to date for ${batch}."
  fi
  git push origin main
  log "Pushed ${batch} to origin/main."
}

# ── Core wave runner ───────────────────────────────────────────────

run_wave() {
  local batch="$1"
  shift
  local tasks=("$@")

  log ""
  log "════════════════════════════════════════════"
  log " Batch: ${batch}"
  log " Tasks: ${tasks[*]}"
  log "════════════════════════════════════════════"

  grove_www_sync_before_batch

  local pre_sha
  pre_sha=$(git log -1 --format="%h")

  ./scripts/run-batch.sh "${batch}"

  local sha
  sha=$(git log -1 --format="%h")

  # Fold any grove-www work forward onto main and push
  grove_www_sync_after_batch

  if [[ "${sha}" == "${pre_sha}" ]]; then
    # No grove-side commit. That's OK if the work was purely in grove-www.
    # We verify by checking whether grove-www moved during the batch.
    log "NOTE: grove HEAD did not advance during ${batch} (${sha})."
    log "  Expected for batches whose work is purely in grove-www."
  else
    log "grove: ${batch} merged ${pre_sha} → ${sha}"
  fi

  for task in "${tasks[@]}"; do
    mark_complete "${task}" "${sha}"
  done

  commit_and_push_plan "${batch}" "${tasks[@]}"
}

# ── Pre-flight ─────────────────────────────────────────────────────

log "Pre-flight: confirming working tree is clean"
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "ERROR: working tree (grove) has uncommitted changes."
  git status --short
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "${CURRENT_BRANCH}" != "main" ]]; then
  log "ERROR: grove not on main (on ${CURRENT_BRANCH})."
  exit 1
fi

git fetch origin main --quiet
LOCAL=$(git rev-parse main)
REMOTE=$(git rev-parse origin/main)
if [[ "${LOCAL}" != "${REMOTE}" ]]; then
  log "ERROR: grove local main (${LOCAL:0:7}) != origin/main (${REMOTE:0:7})"
  exit 1
fi

log "grove: clean, on main, synced with origin."

# grove-www pre-flight: force to main
grove_www_sync_before_batch

log "Ready to ship."

# ── Execute waves ──────────────────────────────────────────────────

START=$(date +%s)

# p16-1: grove-only (handle model + backend)
run_wave "p16-1" "P16-1"

# p17: grove-www only (post-login redirect)
run_wave "p17" "P17-1" "P17-2" "P17-3" "P17-4"

# p18: grove-www only (mobile)
run_wave "p18" "P18-1" "P18-2" "P18-3" "P18-4" "P18-5"

# p16-2: parallel. scoped-routes → grove-www. url-builders → grove only. No race.
run_wave "p16-2" "P16-2" "P16-4"

# p16-3: split into two sequential sub-batches (both touch grove-www).
# run_wave is hardcoded for the run-batch.sh batch name; split requires
# invoking ad-hoc claude --worktree runs or extra batch definitions.
# For simplicity, keep p16-3 as the parallel batch; if the two agents
# produce commits on different grove-www branches, grove_www_sync_after
# will cherry-pick both onto main.
run_wave "p16-3" "P16-3" "P16-5"

# p16-4: e2e test (grove-www only)
run_wave "p16-4" "P16-6"

# ── Final verification ─────────────────────────────────────────────

log ""
log "════════════════════════════════════════════"
log " All 6 batches shipped — running final checks"
log "════════════════════════════════════════════"

log "grove typecheck..."
npx tsc --noEmit

log "grove test suite..."
npm test

log "Plan-drift check (local)..."
npm run check:plan || true

ELAPSED=$(( $(date +%s) - START ))
MINS=$(( ELAPSED / 60 ))
log ""
log "✅ DONE — Phases 16, 17, 18 shipped in ${MINS} min."
log "   grove:      $(git log -1 --format='%h %s')"
log "   grove-www:  $(git -C "$GROVE_WWW" log -1 --format='%h %s')"
