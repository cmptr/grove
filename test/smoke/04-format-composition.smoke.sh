#!/usr/bin/env bash
# Smoke 04: format composition — paths, -0, jsonl, stdin '-'.
# Uses a tiny python HTTP server on a free port so we don't need a full Grove.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_helpers.sh"

echo "# smoke/04-format-composition"

# Spin up a 30-second one-shot stub server using Python.
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')"

python3 - "${PORT}" <<'PY' &
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
port = int(sys.argv[1])

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/v1/list"):
            body = {"entries":[
                {"path":"Resources/People/Alice.md","type":"person"},
                {"path":"Resources/People/Bob.md","type":"person"},
                {"path":"Resources/People/Carol.md","type":"person"},
            ], "count":3}
        elif self.path == "/v1/whoami":
            body = {"key_id":"key_1","key_name":"t","scopes":["read"]}
        else:
            self.send_response(404); self.end_headers(); return
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self,*a,**kw): pass

srv = HTTPServer(("127.0.0.1", port), H)
srv.timeout = 30
import threading
t = threading.Thread(target=srv.serve_forever, daemon=True); t.start()
import time; time.sleep(30)
PY

SERVER_PID=$!
sleep 0.5  # give server time to bind

# Write a config pointing at it.
cat >"${GROVE_CONFIG_DIR}/cli.json" <<EOF
{"server":"http://127.0.0.1:${PORT}","token":"grove_live_smoketest_abc"}
EOF
chmod 600 "${GROVE_CONFIG_DIR}/cli.json"

cleanup() {
  kill "${SERVER_PID}" 2>/dev/null || true
  wait "${SERVER_PID}" 2>/dev/null || true
}
# Restore the _helpers trap and add our cleanup.
trap 'cleanup 2>/dev/null; rm -rf "${SCRATCH}"' EXIT

# --format paths: newline-separated.
out="$("${GROVE}" list "Resources/People/" --format paths)"
ec=$?
assert_exit "list --format paths → exit 0" 0 "${ec}"
line_count=$(printf "%s\n" "${out}" | grep -c . || true)
assert "paths emits 3 lines" "3" "${line_count}"

# --format paths -0: NUL-separated. Bash command substitution strips NULs,
# so write to a file and count NUL bytes directly.
"${GROVE}" list "Resources/People/" --format paths -0 > "${SCRATCH}/nul.out"
nul_count=$(tr -cd '\0' < "${SCRATCH}/nul.out" | wc -c | tr -d ' ')
assert "-0 emits 3 NULs" "3" "${nul_count}"

# Pipe through xargs -0 — should consume cleanly.
"${GROVE}" list "Resources/People/" --format paths -0 | xargs -0 -n1 printf "%s\n" >/dev/null
assert_exit "xargs -0 composition" 0 "$?"

# --format jsonl: one object per line.
out="$("${GROVE}" whoami --format json)"
echo "${out}" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d["ok"]==True'
assert_exit "whoami --format json is valid JSON + ok:true" 0 "$?"

summary
