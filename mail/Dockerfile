ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postfix dovecot-imapd dovecot-lmtpd dovecot-sieve rspamd \
      ca-certificates openssl procps \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 5000 vmail \
 && useradd -u 5000 -g vmail -d /var/vmail -s /usr/sbin/nologin vmail \
 && mkdir -p /var/vmail && chown vmail:vmail /var/vmail

COPY rootfs/ /
RUN cat /etc/postfix/master.cf.append >> /etc/postfix/master.cf \
 && rm /etc/postfix/master.cf.append \
 && postconf -F '*/*/chroot = n' \
 && sievec /etc/dovecot/sieve/spam.sieve \
 && postfix check

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 25 465 587 993
VOLUME /var/vmail
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s \
  CMD postfix status >/dev/null 2>&1 && pgrep -x dovecot >/dev/null && pgrep -x rspamd >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
