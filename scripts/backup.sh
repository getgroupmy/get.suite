#!/usr/bin/env bash
# Backs up Workspace's Docker volumes (the database and files, the mailboxes, the mail settings) into a folder
# of dated copies, and puts one back. For docker-compose.mac.yml, or any set-up that keeps its data in volumes.
#
#   bash scripts/backup.sh                     # a copy now, in ~/workspace-backup/2026-11-23-0300/
#   bash scripts/backup.sh list                # the copies kept
#   bash scripts/backup.sh restore 2026-11-23-0300 --yes   # put that copy back (everything since is lost)
#
# BACKUP_DIR (default ~/workspace-backup) and KEEP (default 14: older copies are removed) can be set.
# The containers stop while it copies (a minute or so for most), so the database is copied whole.
# Every night at 3:00, with crontab -e:   0 3 * * * cd ~/workspace-app && bash scripts/backup.sh >> ~/workspace-backup/log.txt 2>&1
set -u
cd "$(dirname "$0")/.." || exit 1
DIR=${BACKUP_DIR:-$HOME/workspace-backup}
KEEP=${KEEP:-14}
PARTS="data mailboxes mail-config"

# The Docker volume holding a part, found by the label compose gives it (whatever the project folder is called).
volume() { docker volume ls -q --filter "label=com.docker.compose.volume=workspace-$1" | head -n 1; }
containers() { docker ps -a -q --filter name='^nas-workspace(-mail)?$'; }

need_docker() {
  command -v docker >/dev/null 2>&1 || { echo "Docker isn't installed"; exit 1; }
  docker info >/dev/null 2>&1 || { echo "Docker isn't running: open OrbStack or Docker Desktop"; exit 1; }
}

case "${1:-backup}" in
  list)
    ls -1 "$DIR" 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}$' || echo "No copies in $DIR yet"
    ;;
  backup)
    need_docker
    for p in $PARTS; do [[ -n $(volume "$p") ]] || { echo "No volume for $p: is this the volume set-up (docker-compose.mac.yml), started at least once?"; exit 1; }; done
    stamp=$(date +%Y-%m-%d-%H%M)
    out="$DIR/$stamp"
    mkdir -p "$out" || exit 1
    running=$(docker ps -q --filter name='^nas-workspace(-mail)?$')
    [[ -n $running ]] && { echo "Stopping Workspace for the copy…"; docker stop $running >/dev/null; }
    ok=1
    for p in $PARTS; do
      if docker run --rm -v "$(volume "$p")":/v:ro -v "$out":/b alpine tar czf "/b/$p.tgz" -C /v .; then echo "  $p ✓"
      else echo "  $p ✗"; ok=0; fi
    done
    [[ -n $running ]] && { docker start $running >/dev/null; echo "Workspace is running again."; }
    if (( ! ok )); then echo "The copy in $out is incomplete"; exit 1; fi
    echo "Copied to $out"
    # Older copies beyond the last $KEEP go.
    ls -1 "$DIR" | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}$' | sort | awk -v k="$KEEP" '{ a[NR] = $0 } END { for (i = 1; i <= NR - k; i++) print a[i] }' | while read -r old; do rm -rf -- "${DIR:?}/$old"; echo "Removed the old copy $old"; done
    ;;
  restore)
    stamp=${2:-}
    [[ -n $stamp && -d $DIR/$stamp ]] || { echo "Which copy? bash scripts/backup.sh list shows them"; exit 1; }
    [[ ${3:-} == --yes ]] || { echo "This replaces everything in Workspace with the copy from $stamp: anything since is lost. Add --yes to go ahead."; exit 1; }
    need_docker
    for p in $PARTS; do [[ -f $DIR/$stamp/$p.tgz ]] || { echo "The copy from $stamp has no $p.tgz"; exit 1; }; [[ -n $(volume "$p") ]] || { echo "No volume for $p"; exit 1; }; done
    all=$(containers)
    [[ -n $all ]] && docker stop $all >/dev/null
    for p in $PARTS; do
      docker run --rm -v "$(volume "$p")":/v -v "$DIR/$stamp":/b:ro alpine sh -c "find /v -mindepth 1 -delete && tar xzf /b/$p.tgz -C /v" && echo "  $p ✓" || { echo "  $p ✗"; exit 1; }
    done
    [[ -n $all ]] && docker start $all >/dev/null
    echo "Put back the copy from $stamp; Workspace is running again."
    ;;
  *) echo "Use: bash scripts/backup.sh [backup | list | restore <copy> --yes]"; exit 1 ;;
esac
