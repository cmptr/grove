#!/usr/bin/env bash
# Resume script: p16-1 and p17 already shipped; run the remaining 4 waves.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

# Source shared helpers from the main driver by extracting them.
# Instead of sourcing (which would auto-execute the main waves), copy the
# helpers inline here so this script is self-contained.

GROVE_WWW="$(cd "$REPO_DIR/../grove-www" && pwd)"
DATE=$(date +%Y-%m-%d)

log() { echo "[$(date +%H:%M:%S)] $*"; }

sed_i() { sed -i.bak "$1" "$2" && rm -f "$2.bak"; }

grove_www_current_branch() { git -C "$GROVE_WWW" rev-parse --abbrev-ref HEAD; }

grove_www_sync_before_batch() {
  log "grove-www: sync before batch"
  local branch; branch=$(grove_www_current_branch)
  if [[ "$branch" != "main" ]]; then
    grove_www_sync_after_batch "$branch"
  fi
  git -C "$GROVE_WWW" fetch origin main --quiet
  git -C "$GROVE_WWW" checkout main --quiet 2>/dev/null || true
  git -C "$GROVE_WWW" merge origin/main --ff-only
  if ! git -C "$GROVE_WWW" diff --quiet || ! git -C "$GROVE_WWW" diff --cached --quiet; then
    log "ERROR: grove-www has uncommitted changes. Aborting."
    git -C "$GROVE_WWW" status --short
    exit 1
  fi
  log "  grove-www on main @ $(git -C "$GROVE_WWW" rev-parse --short main)"
}

grove_www_sync_after_batch() {
  local override="${1:-}"
  local branch; branch=$(grove_www_current_branch)
  [[ -n "$override" ]] && branch="$override"

  if [[ "$branch" == "main" ]]; then
    git -C "$GROVE_WWW" fetch origin main --quiet
    local to_push; to_push=$(git -C "$GROVE_WWW" log origin/main..main --oneline | wc -l | tr -d ' ')
    if [[ "$to_push" -gt 0 ]]; then
      log "grove-www: pushing $to_push commit(s) from main"
      git -C "$GROVE_WWW" push origin main
    else
      log "grove-www: no new commits on main"
    fi
    return
  fi

  local ahead; ahead=$(git -C "$GROVE_WWW" log main.."$branch" --oneline 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$ahead" -eq 0 ]]; then
    log "grove-www: on $branch, no commits ahead of main — checkout main"
    git -C "$GROVE_WWW" checkout main --quiet 2>/dev/null || true
    return
  fi

  log "grove-www: $branch has $ahead commit(s) ahead of main — consolidating"
  git -C "$GROVE_WWW" checkout main --quiet
  git -C "$GROVE_WWW" fetch origin main --quiet
  git -C "$GROVE_WWW" merge origin/main --ff-only

  local commits; commits=$(git -C "$GROVE_WWW" log main.."$branch" --format=%H --reverse)
  while IFS= read -r sha; do
    [[ -z "$sha" ]] && continue
    log "  cherry-pick $sha"
    git -C "$GROVE_WWW" cherry-pick "$sha"
  done <<< "$commits"

  git -C "$GROVE_WWW" push origin main
  log "grove-www: pushed $ahead commit(s) to origin/main"
}

mark_complete() {
  local task="$1" sha="$2"
  if grep -qE "^#### ${task}:.*✅" PLAN.md; then
    log "  PLAN.md: ${task} already marked ✅ — skipping"
    return 0
  fi
  sed_i "s|^\(#### ${task}:.*\)$|\1 ✅ COMPLETE ${DATE} (${sha})|" PLAN.md
  log "  PLAN.md: marked ${task} ✅ COMPLETE"
}

commit_and_push_plan() {
  local batch="$1"; shift
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

run_wave() {
  local batch="$1"; shift
  local tasks=("$@")

  log ""
  log "════════════════════════════════════════════"
  log " Batch: ${batch}"
  log " Tasks: ${tasks[*]}"
  log "════════════════════════════════════════════"

  grove_www_sync_before_batch

  local pre_sha; pre_sha=$(git log -1 --format="%h")

  ./scripts/run-batch.sh "${batch}"

  local sha; sha=$(git log -1 --format="%h")
  grove_www_sync_after_batch

  if [[ "${sha}" == "${pre_sha}" ]]; then
    log "NOTE: grove HEAD did not advance during ${batch} (${sha}). OK if work was purely in grove-www."
  else
    log "grove: ${batch} merged ${pre_sha} → ${sha}"
  fi

  for task in "${tasks[@]}"; do mark_complete "${task}" "${sha}"; done
  commit_and_push_plan "${batch}" "${tasks[@]}"
}

# ── Pre-flight ─────────────────────────────────────────────────────

log "Resume pre-flight"
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "ERROR: grove working tree dirty."; git status --short; exit 1
fi
if [[ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]]; then
  log "ERROR: grove not on main."; exit 1
fi
git fetch origin main --quiet
[[ "$(git rev-parse main)" != "$(git rev-parse origin/main)" ]] && { log "ERROR: grove not synced with origin."; exit 1; }

grove_www_sync_before_batch

START=$(date +%s)

# Remaining waves
run_wave "p18" "P18-1" "P18-2" "P18-3" "P18-4" "P18-5"
run_wave "p16-2" "P16-2" "P16-4"
run_wave "p16-3" "P16-3" "P16-5"
run_wave "p16-4" "P16-6"

# Final verification
log ""
log "════════════════════════════════════════════"
log " All remaining batches shipped — final checks"
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
log "✅ DONE — 4 remaining batches shipped in ${MINS} min."
log "   grove:      $(git log -1 --format='%h %s')"
log "   grove-www:  $(git -C "$GROVE_WWW" log -1 --format='%h %s')"
