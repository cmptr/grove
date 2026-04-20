#!/usr/bin/env bash
# Smoke 03: config perms are enforced (mode 0600 required).
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_helpers.sh"

echo "# smoke/03-config-perms"

cfg="${GROVE_CONFIG_DIR}/cli.json"
printf '{"server":"http://127.0.0.1:1","token":"grove_live_abcdefg12345"}\n' > "${cfg}"

# World-readable → refused.
chmod 644 "${cfg}"
out="$("${GROVE}" whoami --format json 2>&1 || true)"
ec="$("${GROVE}" whoami --format json >/dev/null 2>&1; echo "$?")"
assert_exit "0644 cfg → exit 2 (auth/config)" 2 "${ec}"
assert_contains "0644 → CONFIG_INSECURE code" "${out}" "CONFIG_INSECURE"
assert_contains "0644 → suggests chmod 600" "${out}" "chmod 600"

# Group-readable → also refused.
chmod 640 "${cfg}"
ec="$("${GROVE}" whoami --format json >/dev/null 2>&1; echo "$?")"
assert_exit "0640 cfg → exit 2" 2 "${ec}"

# Owner-only → accepted (and fails with a DIFFERENT error — connection refused).
chmod 600 "${cfg}"
out="$("${GROVE}" whoami --format json 2>&1 || true)"
# We can't connect to 127.0.0.1:1, so it's CONNECTION_REFUSED / SERVER_ERROR, not CONFIG_INSECURE.
assert_contains "0600 accepted (no longer CONFIG_INSECURE)" "${out}" "${out}"
if [[ "${out}" == *"CONFIG_INSECURE"* ]]; then
  echo "  ✗ 0600 should be accepted but was refused as insecure"
  fail_count=$((fail_count + 1))
else
  echo "  ✓ 0600 accepted"
  pass_count=$((pass_count + 1))
fi

summary
