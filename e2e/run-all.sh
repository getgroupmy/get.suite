#!/bin/bash
# Run every browser test (or those named): e2e/run-all.sh [test.mjs …]. Tests listed in mail-tests.txt run with
# the mail server (--mail), sec-tests.txt with --sec; skip those with NO_MAIL=1. Ends with a summary.
HERE=$(cd "$(dirname "$0")" && pwd)
tests=("$@"); [ ${#tests[@]} -eq 0 ] && tests=($(cd "$HERE/tests" && ls *.mjs))
ok=0; bad=(); skipped=0
for t in "${tests[@]}"; do
  t=$(basename "$t"); mode=""
  grep -qx "$t" "$HERE/mail-tests.txt" && mode=--mail
  grep -qx "$t" "$HERE/sec-tests.txt" && mode=--sec
  if [ -n "$mode" ] && [ -n "${NO_MAIL:-}" ]; then skipped=$((skipped+1)); continue; fi
  if bash "$HERE/run.sh" "$t" $mode; then ok=$((ok+1)); else bad+=("$t"); fi
done
extra=""; [ $skipped -gt 0 ] && extra=", $skipped skipped (mail)"
echo "== ${ok} passed, ${#bad[@]} failed$extra"
[ ${#bad[@]} -gt 0 ] && printf '   %s\n' "${bad[@]}"
[ ${#bad[@]} -eq 0 ]
