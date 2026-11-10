#!/bin/bash
# NAS Workspace mail server: Postfix + Dovecot + Rspamd, configured by the Workspace app.
#
#   /etc/nw      (read-only)  tables, accounts and DKIM keys written by the app
#   /etc/nw-tls  (read-only)  fullchain.pem + privkey.pem (e.g. DSM's Let's Encrypt cert)
#   /var/vmail                mailboxes
#
# Every few seconds the app-written files are copied to /run/nw with safe
# ownership, and the services are reloaded when anything changed.
set -euo pipefail

SRC=${NW_CONFIG_DIR:-/etc/nw}
LIVE=${NW_LIVE_DIR:-/run/nw}
TLS_SRC=${NW_TLS_DIR:-/etc/nw-tls}
TLS_LIVE=${NW_TLS_LIVE_DIR:-/run/nw-tls}
HOSTNAME_FQDN=${MAIL_HOSTNAME:-$(hostname -f)}
INTERVAL=${SYNC_INTERVAL:-5}
STATUS=${NW_STATUS_DIR:-/var/nw-status}   # written here, read by the app: the outgoing queue

log() { echo "[mail] $*"; }

fingerprint() {
  # Paths may not exist yet; that must not stop the script (set -e / pipefail).
  { find "$@" -type f -printf '%p %s %T@\n' 2>/dev/null || true; } | sort | md5sum | cut -d' ' -f1
}
# What the services read, by content: the copies in $LIVE and $TLS_LIVE (not the app's files,
# which can change again between copying and looking, and their times change on every copy).
content_fp() {
  { find "$@" -type f -print0 2>/dev/null | sort -z | xargs -0 -r md5sum 2>/dev/null || true; } | md5sum | cut -d' ' -f1
}
# Whether to copy at all: the app's files, cheaply (names, sizes, times).
fp_all()     { fingerprint "$SRC" "$TLS_SRC"; }
# Change groups, so each change reloads only what needs it. Reloading Dovecot drops every
# open IMAP connection (phones, webmail), so it is reserved for its own settings and TLS.
fp_postfix() { content_fp "$LIVE/postfix" "$TLS_LIVE"; }
fp_dovecot() { content_fp "$LIVE/dovecot/policy.conf" "$TLS_LIVE"; }
fp_rspamd()  { content_fp "$LIVE/dkim"; }

sync_tls() {
  mkdir -p "$TLS_LIVE"
  if [[ -s $TLS_SRC/fullchain.pem && -s $TLS_SRC/privkey.pem ]]; then
    cp "$TLS_SRC/fullchain.pem" "$TLS_LIVE/fullchain.pem"
    cp "$TLS_SRC/privkey.pem" "$TLS_LIVE/privkey.pem"
  elif [[ ! -s $TLS_LIVE/fullchain.pem ]]; then
    log "No certificate in $TLS_SRC; generating a self-signed one for $HOSTNAME_FQDN"
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$HOSTNAME_FQDN" \
      -addext "subjectAltName=DNS:$HOSTNAME_FQDN" \
      -keyout "$TLS_LIVE/privkey.pem" -out "$TLS_LIVE/fullchain.pem" 2>/dev/null
  fi
  chmod 644 "$TLS_LIVE/fullchain.pem"
  chmod 600 "$TLS_LIVE/privkey.pem"
}

sync_config() {
  local tmp="$LIVE.new"
  rm -rf "$tmp"
  mkdir -p "$tmp/postfix" "$tmp/dovecot" "$tmp/dkim" "$tmp/sieve"
  [[ -d $SRC ]] && cp -r "$SRC/." "$tmp/" 2>/dev/null || true
  # Every table must exist even before the app has written anything.
  for f in postfix/domains postfix/mailboxes postfix/aliases postfix/senders dovecot/passwd dovecot/masters; do
    touch "$tmp/$f"
  done
  chown -R root:root "$tmp"
  chmod 755 "$tmp" "$tmp/postfix" "$tmp/dovecot" "$tmp/dkim" "$tmp/sieve"
  # Sieve scripts are read during delivery, which runs as the vmail user.
  find "$tmp/sieve" -type f -exec chmod 644 {} +
  chmod 644 "$tmp"/postfix/*
  chown root:dovecot "$tmp"/dovecot/*
  chmod 640 "$tmp"/dovecot/*
  if compgen -G "$tmp/dkim/*.key" >/dev/null; then
    chown _rspamd:_rspamd "$tmp"/dkim/*.key
    chmod 600 "$tmp"/dkim/*.key
  fi
  rm -rf "$LIVE.old"
  [[ -d $LIVE ]] && mv "$LIVE" "$LIVE.old"
  mv "$tmp" "$LIVE"
  rm -rf "$LIVE.old"
}

# Account files (dovecot/passwd, masters) are re-read by Dovecot automatically when they change,
# and Sieve scripts are read at delivery time, so those need no reload at all. Called right after
# sync_config, it compares what is live now with what the services were last given, so a change
# the app makes while copying is never marked as loaded before it is.
reload_changed() {
  local p d r
  p=$(fp_postfix); d=$(fp_dovecot); r=$(fp_rspamd)
  if [[ $p != "$last_postfix" ]]; then postfix reload >/dev/null 2>&1 || true; log "Reloaded Postfix"; fi
  if [[ $d != "$last_dovecot" ]]; then doveadm reload >/dev/null 2>&1 || true; log "Reloaded Dovecot"; fi
  if [[ $r != "$last_rspamd" ]]; then pkill -HUP -x rspamd 2>/dev/null || true; log "Reloaded Rspamd"; fi
  last_postfix=$p; last_dovecot=$d; last_rspamd=$r
}

# The outgoing queue, for Admin → System: what's waiting (postqueue -j, one JSON object a line),
# headed by when it was read and the last request of the app's that was carried out.
# The last request carried out, kept across restarts: reported as 0 after a restart, the app would
# number its next request 1, at or below what was already done, and it would never run.
QUEUE_DONE=$(cat "$STATUS/queue.done" 2>/dev/null || echo 0)
[[ $QUEUE_DONE =~ ^[0-9]+$ ]] || QUEUE_DONE=0
write_queue_status() {
  mkdir -p "$STATUS"
  local tmp="$STATUS/queue.jsonl.tmp"
  { echo "{\"at\":$(date +%s),\"done\":$QUEUE_DONE}"; postqueue -j 2>/dev/null || true; } > "$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$STATUS/queue.jsonl"
}
# The app's requests, in $SRC/queue/actions: lines of "<seq> flush", "<seq> retry <id>" or
# "<seq> delete <id>". Each is carried out once, in order (the last done is kept across restarts).
run_queue_actions() {
  local f="$SRC/queue/actions" seq op id
  [[ -f $f ]] || return 0
  [[ -f $STATUS/queue.done ]] && QUEUE_DONE=$(cat "$STATUS/queue.done" 2>/dev/null || echo 0)
  [[ $QUEUE_DONE =~ ^[0-9]+$ ]] || QUEUE_DONE=0
  while read -r seq op id _; do
    [[ $seq =~ ^[0-9]+$ ]] && (( seq > QUEUE_DONE )) || continue
    case $op in
      flush) postqueue -f >/dev/null 2>&1 || true ;;
      retry) [[ $id =~ ^[0-9A-Za-z]+$ ]] && { postqueue -i "$id" >/dev/null 2>&1 || true; } ;;
      delete) [[ $id =~ ^[0-9A-Za-z]+$ ]] && { postsuper -d "$id" >/dev/null 2>&1 || true; log "Deleted queued message $id"; } ;;
    esac
    QUEUE_DONE=$seq
  done < "$f"
  mkdir -p "$STATUS"; echo "$QUEUE_DONE" > "$STATUS/queue.done"
}

# A pid file left behind by a process that's gone (a crash, a killed container) stops the service
# from starting ("Dovecot is already running"): it's removed when that number isn't the service.
clear_stale_pid() {
  local file=$1 name=$2 pid
  [[ -f $file ]] || return 0
  pid=$(cat "$file" 2>/dev/null || true)
  pid=${pid//[[:space:]]/}
  if [[ ! $pid =~ ^[0-9]+$ ]] || [[ "$(ps -p "$pid" -o comm= 2>/dev/null)" != "$name" ]]; then
    rm -f "$file"; log "Removed a stale $name pid file"
  fi
}

stop_all() {
  log "Stopping"
  postfix stop >/dev/null 2>&1 || true
  doveadm stop >/dev/null 2>&1 || true
  pkill -TERM -x rspamd 2>/dev/null || true
  exit 0
}
trap stop_all TERM INT

# Sourced with NW_MAIL_FUNCTIONS_ONLY=1 (tests): just the functions above.
if [[ ${NW_MAIL_FUNCTIONS_ONLY:-} == 1 ]]; then trap - TERM INT; return 0; fi

log "Starting mail server for $HOSTNAME_FQDN"
postconf -e "myhostname = $HOSTNAME_FQDN"
# Postfix's log goes to a file the app reads too (Admin → Email → Email log), and is shown on the console.
mkdir -p "$STATUS"
postconf -e "maillog_file = $STATUS/maillog" "maillog_file_compressor = gzip"
touch "$STATUS/maillog"; chmod 644 "$STATUS/maillog"
echo "$HOSTNAME_FQDN" > /etc/mailname
echo "hostname = $HOSTNAME_FQDN" > /etc/dovecot/hostname.conf   # used in auto-reply Message-IDs
mkdir -p /var/vmail /run/dovecot /run/rspamd /var/lib/rspamd
chown vmail:vmail /var/vmail
chown _rspamd:_rspamd /run/rspamd /var/lib/rspamd

sync_tls
sync_config
last=$(fp_all); last_postfix=$(fp_postfix); last_dovecot=$(fp_dovecot); last_rspamd=$(fp_rspamd)

clear_stale_pid /run/dovecot/master.pid dovecot
clear_stale_pid /run/rspamd/rspamd.pid rspamd
# Postfix too: its master.pid holding a number some other process now has makes "postfix start" say it's already running.
clear_stale_pid "$(postconf -h queue_directory 2>/dev/null || echo /var/spool/postfix)/pid/master.pid" master
rspamd -f -u _rspamd -g _rspamd &
dovecot
postfix start-fg &   # foreground mode: the container runs as long as Postfix does
tail -n0 -F "$STATUS/maillog" 2>/dev/null &   # Postfix's log on the container console, as before

# The log file kept to about 20 MB: Postfix starts a new one, and the newest two old ones are kept (gzipped).
rotate_maillog() {
  local size; size=$(stat -c %s "$STATUS/maillog" 2>/dev/null || echo 0)
  (( size > 20 * 1024 * 1024 )) || return 0
  postfix logrotate >/dev/null 2>&1 || return 0
  ls -1t "$STATUS"/maillog.*.gz 2>/dev/null | tail -n +3 | xargs -r rm -f
  chmod 644 "$STATUS"/maillog* 2>/dev/null || true
}

running() { postfix status >/dev/null 2>&1 && pgrep -x dovecot >/dev/null && pgrep -x rspamd >/dev/null; }
# A cold start can take a while on a small NAS (Rspamd compiles its rules first), so wait up to 2 minutes.
for _ in $(seq 1 120); do running && break; sleep 1; done
running || { log "Services failed to start"; exit 1; }
log "Ready: SMTP 25, submission 587/465, IMAPS 993"

while true; do
  sleep "$INTERVAL" &
  wait $! || true
  now=$(fp_all)
  if [[ $now != "$last" ]]; then
    sync_tls
    sync_config
    reload_changed
    last=$now
  fi
  run_queue_actions || true
  write_queue_status || true
  rotate_maillog || true
  pgrep -x master >/dev/null || { log "postfix died"; exit 1; }   # (not "postfix status": that writes to the mail log each time)
  pgrep -x dovecot >/dev/null || { log "dovecot died"; exit 1; }
  pgrep -x rspamd >/dev/null || { log "rspamd died"; exit 1; }
done
