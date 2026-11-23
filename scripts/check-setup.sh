#!/usr/bin/env bash
# Checks that this machine is ready for Workspace (before the first start) and that it runs as it should
# (after). Made for a Mac (Apple Silicon or Intel) with Docker Desktop or OrbStack; works on Linux too.
#
#   bash scripts/check-setup.sh                      # docker-compose.mac.yml on a Mac, docker-compose.yml elsewhere
#   bash scripts/check-setup.sh docker-compose.yml   # a compose file of your choosing
#   bash scripts/check-setup.sh --https              # with HTTPS from Caddy (--profile https): ports 80 and 443 too
#
# ✓ fine · ! worth a look · ✗ needs fixing. Exits 1 when something needs fixing.
set -u
cd "$(dirname "$0")/.." || exit 1

bad=0
ok()   { printf '  \342\234\223 %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
fail() { printf '  \342\234\227 %s\n' "$*"; bad=1; }

https=0
if [[ ${1:-} == --https ]]; then https=1; shift; fi
os=$(uname -s); hw=$(uname -m)
if [[ $# -ge 1 ]]; then file=$1; elif [[ $os == Darwin ]]; then file=docker-compose.mac.yml; else file=docker-compose.yml; fi

echo "This machine"
case "$os/$hw" in
  Darwin/arm64) ok "A Mac with Apple Silicon: the containers build for arm64 and run natively" ;;
  Darwin/x86_64) ok "A Mac with an Intel chip: the containers build for x86-64" ;;
  Linux/x86_64|Linux/aarch64|Linux/arm64) ok "Linux on $hw" ;;
  *) warn "$os on $hw: not a set-up this has been tried on" ;;
esac
# Node's name for this kind of chip, to compare with what the app reports once it runs.
case "$hw" in arm64|aarch64) want=arm64 ;; x86_64|amd64) want=x64 ;; *) want=$hw ;; esac

echo "Docker"
if ! command -v docker >/dev/null 2>&1; then
  fail "Docker isn't installed: install OrbStack or Docker Desktop, then run this again"
  echo; echo "Fix what's marked ✗ and run this again."; exit 1
fi
if ! docker info >/dev/null 2>&1; then
  fail "Docker is installed but not running: open OrbStack or Docker Desktop (and set it to start at login)"
  echo; echo "Fix what's marked ✗ and run this again."; exit 1
fi
ok "Docker is running"
if docker compose version >/dev/null 2>&1; then ok "docker compose is there"; else fail "docker compose is missing (it comes with OrbStack and Docker Desktop)"; fi

echo "Compose file: $file"
if [[ ! -f $file ]]; then
  fail "There's no $file here"
elif docker compose -f "$file" config --quiet >/dev/null 2>&1; then
  ok "It reads correctly"
  if grep -q '&mail_hostname mail\.example\.com' "$file"; then warn "The mail hostname is still mail.example.com: set yours at the top of $file"; fi
  if grep -q '&timezone UTC' "$file"; then warn "The time zone is UTC: set yours (e.g. Europe/London) at the top of $file if it isn't"; fi
else
  fail "It has a mistake: run  docker compose -f $file config  to see where"
fi

running() { [[ $(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null) == true ]]; }

if ! running nas-workspace; then
  echo "Before the first start"
  ports="8080 25 465 587 993"; (( https )) && ports="$ports 80 443"
  for p in $ports; do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then fail "Port $p is taken by another program: $(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1}')"
    else ok "Port $p is free"; fi
  done
  free_gb=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{print int($4/1048576)}')
  if [[ -n ${free_gb:-} ]]; then
    if (( free_gb < 10 )); then warn "Only ${free_gb} GB free on the disk: files and mail need room to grow"; else ok "${free_gb} GB free on the disk"; fi
  fi
  echo
  if (( https )); then echo "Start it with:  docker compose -f $file --profile https up -d --build"; else echo "Start it with:  docker compose -f $file up -d --build"; fi
  echo "then run this again to check it's working."
else
  echo "Running"
  ok "The app's container is running"
  arch=$(docker exec nas-workspace node -p process.arch 2>/dev/null | tr -d '\r')
  if [[ -z $arch ]]; then warn "Couldn't ask the app which chip it runs on"
  elif [[ $arch == "$want" ]]; then ok "It runs natively ($arch)"
  else fail "It runs as $arch on this $want machine, through emulation (slow): rebuild with  docker compose -f $file build --no-cache"; fi
  if curl -fsS --max-time 5 http://localhost:8080/api/health >/dev/null 2>&1; then ok "It answers at http://localhost:8080"
  else fail "It doesn't answer at http://localhost:8080: see  docker logs nas-workspace"; fi
  if running nas-workspace-mail; then ok "The mail server's container is running"
  else fail "The mail server's container isn't running: see  docker logs nas-workspace-mail"; fi
  # HTTPS from Caddy, when it's in use (or asked for).
  web=$(awk '/^x-web-hostname:/{print $3}' "$file" 2>/dev/null)
  if running nas-workspace-caddy; then
    ok "Caddy (HTTPS) is running"
    if [[ -z $web || $web == workspace.example.com ]]; then warn "The web address is still workspace.example.com: set x-web-hostname at the top of $file"
    elif curl -fsS --max-time 10 -o /dev/null "https://$web/api/health" 2>/dev/null; then ok "https://$web answers, with a valid certificate"
    else warn "https://$web doesn't answer yet: its DNS must point here and ports 80 and 443 reach this machine (docker logs nas-workspace-caddy says why)"; fi
  elif (( https )); then fail "Caddy (HTTPS) isn't running: start with  docker compose -f $file --profile https up -d"
  fi
  if [[ $os == Darwin ]] && command -v pmset >/dev/null 2>&1; then
    if [[ $(pmset -g 2>/dev/null | awk '$1=="sleep"{print $2}') == 0 ]]; then ok "The Mac doesn't go to sleep"
    else warn "The Mac may go to sleep: System Settings → Energy → Prevent automatic sleeping"; fi
  fi
fi

echo
if (( bad )); then echo "Fix what's marked ✗ and run this again."; exit 1; fi
echo "All set."
