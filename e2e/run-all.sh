#!/bin/bash
# Run every browser test (or those named): e2e/run-all.sh [test.mjs …]
#   JOBS=4      run the tests that don't need the mail server 4 at a time (each its own server and port, from 8100)
#   NO_MAIL=1   leave out those that do (mail-tests.txt: run with --mail; sec-tests.txt: --sec), one at a time on 8080
# Ends with a summary; exits 1 if any failed.
HERE=$(cd "$(dirname "$0")" && pwd)
tests=("$@"); [ ${#tests[@]} -eq 0 ] && tests=($(cd "$HERE/tests" && ls *.mjs))
JOBS=${JOBS:-1}
plain=(); special=(); skipped=0
for t in "${tests[@]}"; do
  t=$(basename "$t")
  if grep -qx "$t" "$HERE/mail-tests.txt" "$HERE/sec-tests.txt"; then
    if [ -n "${NO_MAIL:-}" ]; then skipped=$((skipped+1)); else special+=("$t"); fi
  else plain+=("$t"); fi
done
RES=$(mktemp -d)
# Plain tests: JOBS groups side by side, each on its own port.
for j in $(seq 0 $((JOBS - 1))); do
  (
    for ((i = j; i < ${#plain[@]}; i += JOBS)); do
      t=${plain[$i]}
      if PORT=$((8100 + j)) bash "$HERE/run.sh" "$t"; then echo "$t" >> "$RES/ok.$j"; else echo "$t" >> "$RES/bad.$j"; fi
    done
  ) &
done
wait
# Mail and sign-in protection tests: one at a time, on 8080.
for t in "${special[@]}"; do
  mode=--mail; grep -qx "$t" "$HERE/sec-tests.txt" && mode=--sec
  if PORT=8080 bash "$HERE/run.sh" "$t" $mode; then echo "$t" >> "$RES/ok.m"; else echo "$t" >> "$RES/bad.m"; fi
done
ok=$(cat "$RES"/ok.* 2>/dev/null | wc -l); bad=$(cat "$RES"/bad.* 2>/dev/null | sort)
nbad=$(echo -n "$bad" | grep -c . || true)
extra=""; [ $skipped -gt 0 ] && extra=", $skipped skipped (mail)"
echo "== $ok passed, $nbad failed$extra"
[ -n "$bad" ] && echo "$bad" | sed 's/^/   /'
rm -rf "$RES"
[ "$nbad" -eq 0 ]
