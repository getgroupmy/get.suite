#!/usr/bin/env bash
# Updates Workspace on a Mac (or any Docker machine) once the new code is in this folder: a backup first
# (scripts/backup.sh), then the containers rebuilt and restarted, then a wait until the app answers again.
# If it doesn't come back, it says how to put the backup back.
#
#   bash scripts/update.sh            # with docker-compose.mac.yml
#   bash scripts/update.sh --https    # the same, with Caddy (--profile https)
#
# FILE (default docker-compose.mac.yml), and WAIT (seconds to wait for it to answer, default 180) can be set.
set -u
cd "$(dirname "$0")/.." || exit 1
FILE=${FILE:-docker-compose.mac.yml}
WAIT=${WAIT:-180}
profile=()
[[ ${1:-} == --https ]] && profile=(--profile https)

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { echo "Docker isn't running: open OrbStack or Docker Desktop"; exit 1; }
[[ -f $FILE ]] || { echo "There's no $FILE here"; exit 1; }
docker compose -f "$FILE" config --quiet >/dev/null 2>&1 || { echo "$FILE has a mistake: run  docker compose -f $FILE config  to see where"; exit 1; }

echo "1. A backup first"
if ! out=$(bash scripts/backup.sh 2>&1); then
  echo "$out"; echo "The backup didn't work, so nothing was updated."; exit 1
fi
echo "$out" | sed 's/^/   /'
copy=$(echo "$out" | sed -n 's/^Copied to .*\///p' | tail -n 1)

echo "2. Building and restarting"
if ! docker compose -f "$FILE" ${profile[@]+"${profile[@]}"} up -d --build; then
  echo "The build or start failed (above). Workspace's data is as it was; the backup is $copy."; exit 1
fi

echo "3. Waiting for it to answer"
for ((i = 0; i < WAIT; i += 3)); do
  if curl -fsS --max-time 3 http://localhost:8080/api/health >/dev/null 2>&1; then
    echo "   Workspace is up again."
    echo; echo "Updated. bash scripts/check-setup.sh${profile:+ --https} checks the rest."
    exit 0
  fi
  sleep 3
done
echo "   It hasn't answered after ${WAIT}s: see  docker logs nas-workspace"
echo "To go back to how it was before the update: put back the old code, then"
echo "  bash scripts/backup.sh restore $copy --yes"
exit 1
