#!/bin/bash
# Run one browser test against a fresh server: e2e/run.sh <test.mjs> [--mail|--sec]
#   --mail  with this machine's Postfix/Dovecot/Rspamd (see the README's mail integration test); clears their mail first
#   --sec   as --mail, for sign-in protection tests (localhost never banned)
# The web app must be built (cd web && npx vite build). Prints "<test>: N passed, M failed" and the failures;
# screenshots and downloads go to e2e/out/<test>/. Exits 1 when a step failed.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(dirname "$HERE")
T=$(basename "$1"); MODE=${2:-}
[ -f "$HERE/tests/$T" ] || { echo "no such test: $T"; exit 2; }
[ -f "$ROOT/web/dist/index.html" ] || { echo "build the web app first: cd web && npx vite build"; exit 2; }
[ -d "$HERE/node_modules/playwright" ] || { echo "install the test tools first: cd e2e && npm install && npx playwright install chromium"; exit 2; }
OUT="$HERE/out/${T%.mjs}"; rm -rf "$OUT"; mkdir -p "$OUT/shots"
PORT=8080
for p in $(pgrep -f "node.*src/index[.]js"); do kill $p 2>/dev/null; done
for i in $(seq 1 50); do curl -s -o /dev/null localhost:$PORT || break; sleep 0.3; done
ENVV="DATA_DIR=$OUT/data PUBLIC_DIR=$ROOT/web/dist PORT=$PORT"
if [ "$MODE" = --mail ] || [ "$MODE" = --sec ]; then
  sudo bash -c 'rm -rf /etc/nw/* /var/vmail/*'
  sudo postsuper -d ALL >/dev/null 2>&1 || true
  ENVV="$ENVV MAIL_CONFIG_DIR=/etc/nw MAIL_STATUS_DIR=/var/nw-status MAIL_IMAP_HOST=127.0.0.1 MAIL_HOSTNAME=mail.acme.com AUTH_POLICY_URL=http://127.0.0.1:8081/ MAIL_IMPORT_ALLOW_PRIVATE=1"
  [ "$MODE" = --sec ] && ENVV="$ENVV AUTH_NEVER_BAN=127.0.0.1/32,::1 AUTH_SOFT_NETS="
fi
(cd "$ROOT/server" && env $ENVV nohup node --no-warnings=ExperimentalWarning src/index.js > "$OUT/server.log" 2>&1 &)
for i in $(seq 1 100); do curl -s -o /dev/null localhost:$PORT && break; sleep 0.3; done
out=$(cd "$HERE" && BASE=http://localhost:$PORT timeout 600 node "tests/$T" "$OUT" 2>&1); code=$?
echo "$out" > "$OUT/output.txt"
for p in $(pgrep -f "node.*src/index[.]js"); do kill $p 2>/dev/null; done
pass=$(echo "$out" | grep -cE '^PASS'); fail=$(echo "$out" | grep -cE '^FAIL')
[ $code -ne 0 ] && [ $fail -eq 0 ] && fail=1 && out="$out
FAIL (the script stopped: exit $code) $(echo "$out" | tail -3 | tr '\n' ' ')"
echo "$T: $pass passed, $fail failed"
echo "$out" | grep -E "^FAIL|^ERRORS" | cut -c1-500
[ $fail -eq 0 ]
