#!/usr/bin/env bash
# Smoke 05: SIGPIPE via `| head -1` exits 0 cleanly, no stack trace.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_helpers.sh"

echo "# smoke/05-sigpipe"

# `grove help` to a broken pipe should exit 0 — the closing pipe is expected.
# Capture PIPESTATUS so we see grove's exit, not head's.
out=$("${GROVE}" help 2>&1 | head -1)
pipestatus="${PIPESTATUS[0]}"
assert_exit "grove help | head -1 → grove exit 0" 0 "${pipestatus}"

# No Node stack trace.
if [[ "${out}" == *"EPIPE"* ]]; then
  echo "  ✗ EPIPE visible in output (should be suppressed)"
  fail_count=$((fail_count + 1))
else
  echo "  ✓ no EPIPE in output"
  pass_count=$((pass_count + 1))
fi

if [[ "${out}" == *"at process."* ]]; then
  echo "  ✗ Node stack trace visible (should be suppressed)"
  fail_count=$((fail_count + 1))
else
  echo "  ✓ no stack trace in output"
  pass_count=$((pass_count + 1))
fi

summary
