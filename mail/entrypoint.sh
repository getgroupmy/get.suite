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
LIVE=/run/nw
TLS_SRC=${NW_TLS_DIR:-/etc/nw-tls}
TLS_LIVE=/run/nw-tls
HOSTNAME_FQDN=${MAIL_HOSTNAME:-$(hostname -f)}
INTERVAL=${SYNC_INTERVAL:-5}

log() { echo "[mail] $*"; }

fingerprint() {
  # Paths may not exist yet; that must not stop the script (set -e / pipefail).
  { find "$@" -type f -printf '%p %s %T@\n' 2>/dev/null || true; } | sort | md5sum | cut -d' ' -f1
}
# Change groups, so each change reloads only what needs it. Reloading Dovecot drops every
# open IMAP connection (phones, webmail), so it is reserved for its own settings and TLS.
fp_all()     { fingerprint "$SRC" "$TLS_SRC"; }
fp_postfix() { fingerprint "$SRC/postfix" "$TLS_SRC"; }
fp_dovecot() { fingerprint "$SRC/dovecot/policy.conf" "$TLS_SRC"; }
fp_rspamd()  { fingerprint "$SRC/dkim"; }

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
# and Sieve scripts are read at delivery time, so those need no reload at all.
reload_changed() {
  local p d r
  p=$(fp_postfix); d=$(fp_dovecot); r=$(fp_rspamd)
  if [[ $p != "$last_postfix" ]]; then postfix reload >/dev/null 2>&1 || true; log "Reloaded Postfix"; fi
  if [[ $d != "$last_dovecot" ]]; then doveadm reload >/dev/null 2>&1 || true; log "Reloaded Dovecot"; fi
  if [[ $r != "$last_rspamd" ]]; then pkill -HUP -x rspamd 2>/dev/null || true; log "Reloaded Rspamd"; fi
  last_postfix=$p; last_dovecot=$d; last_rspamd=$r
}

stop_all() {
  log "Stopping"
  postfix stop >/dev/null 2>&1 || true
  doveadm stop >/dev/null 2>&1 || true
  pkill -TERM -x rspamd 2>/dev/null || true
  exit 0
}
trap stop_all TERM INT

log "Starting mail server for $HOSTNAME_FQDN"
postconf -e "myhostname = $HOSTNAME_FQDN"
echo "$HOSTNAME_FQDN" > /etc/mailname
echo "hostname = $HOSTNAME_FQDN" > /etc/dovecot/hostname.conf   # used in auto-reply Message-IDs
mkdir -p /var/vmail /run/dovecot /run/rspamd /var/lib/rspamd
chown vmail:vmail /var/vmail
chown _rspamd:_rspamd /run/rspamd /var/lib/rspamd

sync_tls
sync_config
last=$(fp_all); last_postfix=$(fp_postfix); last_dovecot=$(fp_dovecot); last_rspamd=$(fp_rspamd)

rspamd -f -u _rspamd -g _rspamd &
dovecot
postfix start-fg &   # foreground mode keeps Postfix logs on the container console

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
  postfix status >/dev/null 2>&1 || { log "postfix died"; exit 1; }
  pgrep -x dovecot >/dev/null || { log "dovecot died"; exit 1; }
  pgrep -x rspamd >/dev/null || { log "rspamd died"; exit 1; }
done
