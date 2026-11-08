// The mail container's config sync (mail/entrypoint.sh): the app's files are copied to where the
// services read them, and Postfix/Dovecot/Rspamd are reloaded exactly when what they read changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRYPOINT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../mail/entrypoint.sh');

/** Runs `steps` (bash) with the entrypoint's functions, the services stubbed, in a scratch folder. */
function run(steps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-mailsync-'));
  const script = `
set -euo pipefail
export NW_MAIL_FUNCTIONS_ONLY=1 NW_CONFIG_DIR=${dir}/src NW_TLS_DIR=${dir}/tls NW_LIVE_DIR=${dir}/live NW_TLS_LIVE_DIR=${dir}/tls-live MAIL_HOSTNAME=mail.test
mkdir -p ${dir}/src/postfix ${dir}/src/dovecot ${dir}/tls
echo cert > ${dir}/tls/fullchain.pem; echo key > ${dir}/tls/privkey.pem
source ${JSON.stringify(ENTRYPOINT)}
# Stand-ins for the real services and for ownership (the test isn't root).
chown() { :; }
CALLS=${dir}/calls; : > "$CALLS"
postfix() { echo "POSTFIX $1" >> "$CALLS"; }
doveadm() { echo "DOVEADM $1" >> "$CALLS"; }
pkill() { echo "RSPAMD $*" >> "$CALLS"; }
calls() { cat "$CALLS"; : > "$CALLS"; }
log() { :; }
put() { mkdir -p "$(dirname "$SRC/$1")"; printf '%s\\n' "$2" > "$SRC/$1"; }
cycle() { echo "-- $1"; sync_tls; sync_config; reload_changed; calls; }
put postfix/senders "kim@acme.test kim@acme.test"
sync_tls; sync_config
last_postfix=$(fp_postfix); last_dovecot=$(fp_dovecot); last_rspamd=$(fp_rspamd)
${steps}
echo "LIVE $(tr '\\n' ' ' < "$LIVE/postfix/senders")"
`;
  try { return execFileSync('bash', ['-c', script], { encoding: 'utf8' }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('mail sync: a change made while copying is still loaded on the next round', () => {
  const out = run(`
put postfix/senders "kim@acme.test kim@acme.test
fay@acme.test fay@acme.test"
sync_tls; sync_config
# The app writes again after the copy but before the services are reloaded (a new account a moment later).
put postfix/senders "kim@acme.test kim@acme.test
fay@acme.test fay@acme.test
lee@acme.test lee@acme.test"
echo "-- first"; reload_changed; calls
cycle second
cycle unchanged
`);
  const after = (label) => out.split(`-- ${label}\n`)[1].split('-- ')[0];
  assert.match(after('first'), /POSTFIX reload/, 'Postfix is given the copy it has');
  assert.match(after('second'), /POSTFIX reload/, 'and reloaded again for the later change, which is now live');
  assert.doesNotMatch(after('unchanged'), /reload|RSPAMD/, 'nothing new: nothing reloaded');
  assert.match(out, /LIVE kim@acme\.test kim@acme\.test fay@acme\.test fay@acme\.test lee@acme\.test lee@acme\.test/);
});

test('mail sync: each kind of change reloads only what reads it', () => {
  const out = run(`
put dovecot/passwd "kim@acme.test:{SHA512-CRYPT}x::::::"
cycle accounts
put dovecot/policy.conf "auth_policy_server_url = http://app/"
cycle policy
put dkim/acme.test.key "secret"
cycle dkim
echo cert2 > "$TLS_SRC/fullchain.pem"
cycle tls
`);
  const after = (label) => out.split(`-- ${label}\n`)[1].split('-- ')[0].split('\nLIVE')[0].trim();
  assert.equal(after('accounts'), '', 'Dovecot re-reads accounts by itself');
  assert.equal(after('policy'), 'DOVEADM reload');
  assert.equal(after('dkim'), 'RSPAMD -HUP -x rspamd');
  assert.equal(after('tls'), 'POSTFIX reload\nDOVEADM reload');
});
