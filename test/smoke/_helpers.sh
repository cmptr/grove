# Shared helpers for smoke tests. Source this at the top of each *.smoke.sh.
set -euo pipefail

# Resolve repo root (works no matter where the script is invoked from).
SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SMOKE_DIR}/../.." && pwd)"
GROVE="${REPO_ROOT}/bin/grove"

# Colors disabled for deterministic output.
export NO_COLOR=1

# Scratch dir + auto cleanup.
SCRATCH="$(mktemp -d -t grove-smoke.XXXXXX)"
trap 'rm -rf "${SCRATCH}"' EXIT

# Point grove at an isolated config dir (no real credentials).
export GROVE_CONFIG_DIR="${SCRATCH}/.grove"
mkdir -p "${GROVE_CONFIG_DIR}"
chmod 700 "${GROVE_CONFIG_DIR}"

# ── Assertions ─────────────────────────────────────────────────

pass_count=0
fail_count=0

assert() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [ "${expected}" = "${actual}" ]; then
    printf "  \033[32m✓\033[0m %s\n" "${label}"
    pass_count=$((pass_count + 1))
  else
    printf "  \033[31m✗\033[0m %s\n     expected: %s\n     actual:   %s\n" "${label}" "${expected}" "${actual}"
    fail_count=$((fail_count + 1))
  fi
}

assert_exit() {
  local label="$1"
  local expected_exit="$2"
  local actual_exit="$3"
  assert "${label} (exit ${expected_exit})" "${expected_exit}" "${actual_exit}"
}

assert_contains() {
  local label="$1"
  local haystack="$2"
  local needle="$3"
  if [[ "${haystack}" == *"${needle}"* ]]; then
    printf "  \033[32m✓\033[0m %s\n" "${label}"
    pass_count=$((pass_count + 1))
  else
    printf "  \033[31m✗\033[0m %s\n     expected to contain: %s\n     actual: %s\n" "${label}" "${needle}" "${haystack:0:300}"
    fail_count=$((fail_count + 1))
  fi
}

summary() {
  printf "\n  %d passed, %d failed\n" "${pass_count}" "${fail_count}"
  if [ "${fail_count}" -gt 0 ]; then
    exit 1
  fi
}
