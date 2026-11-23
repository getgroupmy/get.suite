// The mail server's certificate (mail/entrypoint.sh): one placed in /etc/nw-tls wins; otherwise Caddy's for the
// mail hostname (docker-compose.mac.yml --profile https), the newest if two issuers have one; otherwise a
// self-signed one. A new or renewed certificate from Caddy changes the fingerprint the script watches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const entry = fs.readFileSync(new URL('../../mail/entrypoint.sh', import.meta.url), 'utf8');
const fn = (name) => entry.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, 'm'))?.[0] ?? entry.match(new RegExp(`^${name}\\(\\).*$`, 'm'))[0];
const functions = ['fingerprint', 'fp_all', 'caddy_cert', 'sync_tls'].map(fn).join('\n');

const setup = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-mailtls-'));
  for (const sub of ['src', 'tls', 'live', 'caddy']) fs.mkdirSync(path.join(d, sub));
  return d;
};
const run = (d, script = 'sync_tls; cat "$TLS_LIVE/fullchain.pem"') => {
  const r = spawnSync('bash', ['-c', `set -euo pipefail
log() { echo "[mail] $*"; }
SRC=${d}/src TLS_SRC=${d}/tls TLS_LIVE=${d}/live CADDY_TLS=${d}/caddy HOSTNAME_FQDN=mail.acme.com
${functions}
${script}`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const caddyCert = (d, issuer, text, when) => {
  const dir = path.join(d, 'caddy/caddy/certificates', issuer, 'mail.acme.com');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mail.acme.com.crt'), text);
  fs.writeFileSync(path.join(dir, 'mail.acme.com.key'), `key for ${text}`);
  if (when) for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), when, when);
};

test('mail certificate: Caddy\'s for the mail hostname, the newest issuer\'s; one of your own wins', () => {
  const d = setup();
  caddyCert(d, 'acme-v02.api.letsencrypt.org-directory', 'LE chain', 2_000_000_000);
  caddyCert(d, 'acme.zerossl.com-v2-dv90', 'ZeroSSL chain', 1_000_000_000);
  // Someone else's hostname isn't taken.
  fs.mkdirSync(path.join(d, 'caddy/caddy/certificates/x/workspace.acme.com'), { recursive: true });
  fs.writeFileSync(path.join(d, 'caddy/caddy/certificates/x/workspace.acme.com/workspace.acme.com.crt'), 'web chain');
  assert.equal(run(d), 'LE chain');
  assert.equal(fs.readFileSync(path.join(d, 'live/privkey.pem'), 'utf8'), 'key for LE chain');
  assert.equal((fs.statSync(path.join(d, 'live/privkey.pem')).mode & 0o777).toString(8), '600');
  fs.writeFileSync(path.join(d, 'tls/fullchain.pem'), 'my own chain');
  fs.writeFileSync(path.join(d, 'tls/privkey.pem'), 'my own key');
  assert.equal(run(d), 'my own chain', 'a certificate placed in /etc/nw-tls comes first');
});

test('mail certificate: without a key from Caddy, or none at all, a self-signed one; Caddy\'s arriving later is noticed', () => {
  const d = setup();
  const dir = path.join(d, 'caddy/caddy/certificates/le/mail.acme.com');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mail.acme.com.crt'), 'no key with it');
  const out = run(d, 'sync_tls; head -n 1 "$TLS_LIVE/fullchain.pem"');
  assert.match(out, /self-signed one for mail\.acme\.com/);
  assert.match(out, /BEGIN CERTIFICATE/);
  const before = run(d, 'fp_all').trim();
  caddyCert(d, 'le', 'LE chain');
  assert.notEqual(run(d, 'fp_all').trim(), before, 'a certificate from Caddy is a change to act on');
  assert.equal(run(d), 'LE chain', 'and it replaces the self-signed one');
});
