#!/usr/bin/env bash
# Smoke 02: token in argv is refused (ps-aux leak protection).
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_helpers.sh"

echo "# smoke/02-token-argv-guard"

# Non-init command with --token= flag → exit 1 + TOKEN_IN_ARGV error.
out="$("${GROVE}" search foo --token=grove_live_abcdefg12345 --format json 2>&1 || true)"
ec="$("${GROVE}" search foo --token=grove_live_abcdefg12345 --format json >/dev/null 2>&1; echo "$?")"
assert_exit "search --token= → exit 1" 1 "${ec}"
assert_contains "envelope has TOKEN_IN_ARGV code" "${out}" "TOKEN_IN_ARGV"
assert_contains "envelope has executable suggestion" "${out}" "grove init"

# Token buried in positional also refused.
ec="$("${GROVE}" search grove_live_abcdefg12345 --format json >/dev/null 2>&1; echo "$?")"
assert_exit "token as positional → exit 1" 1 "${ec}"

# No token → no guard fires (but we get CONFIG_MISSING since harness dir is empty).
out="$("${GROVE}" search hello --format json 2>&1 || true)"
assert_contains "no-token path → CONFIG_MISSING (not TOKEN_IN_ARGV)" "${out}" "CONFIG_MISSING"

summary
