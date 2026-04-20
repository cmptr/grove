#!/usr/bin/env bash
# Smoke 01: bin/grove exists, help renders, exits 0.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_helpers.sh"

echo "# smoke/01-install"

# bin/grove should be executable.
[ -x "${GROVE}" ]
assert_exit "bin/grove is executable" 0 "$?"

# help exits 0 and mentions known commands.
out="$("${GROVE}" help)"
assert_contains "help lists 'search'" "${out}" "search"
assert_contains "help lists 'write'" "${out}" "write"
assert_contains "help lists 'init'" "${out}" "init"

# --help exits 0 too.
"${GROVE}" --help >/dev/null
assert_exit "--help exits 0" 0 "$?"

summary
