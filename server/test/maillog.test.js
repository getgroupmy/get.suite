import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseMaillog, readMaillog, messagesFor } from '../src/mail/maillog.js';

const LOG = `Nov 10 02:26:30 mail postfix/qmgr[22875]: 418E0949B4: from=<olivia@acme.com>, size=494, nrcpt=1 (queue active)
Nov 10 02:26:31 mail postfix/postfix-script[22890]: the Postfix mail system is running: PID: 22873
Nov 10 02:26:33 mail postfix/smtp[22880]: 418E0949B4: to=<client@[192.0.2.10]>, relay=none, delay=318, delays=315/0.02/3.1/0, dsn=4.4.1, status=deferred (connect to 192.0.2.10[192.0.2.10]:25: No route to host)
Nov 10 02:26:41 mail postfix/smtpd[23044]: 5D7749497A: client=localhost[127.0.0.1]
Nov 10 02:26:41 mail postfix/cleanup[23046]: 5D7749497A: message-id=<logtest-1@globex.com>
Nov 10 02:26:41 mail postfix/qmgr[22875]: 5D7749497A: from=<x@globex.com>, size=462, nrcpt=1 (queue active)
Nov 10 02:26:41 mail postfix/smtpd[23044]: NOQUEUE: reject: RCPT from localhost[127.0.0.1]: 550 5.1.1 <nobody-here@acme.com>: Recipient address rejected: User unknown in virtual mailbox table; from=<x@globex.com> to=<nobody-here@acme.com> proto=ESMTP helo=<test>
Nov 10 02:26:41 mail postfix/lmtp[23047]: 5D7749497A: to=<olivia@acme.com>, orig_to=<postmaster@acme.com>, relay=mail.acme.com[private/dovecot-lmtp], delay=0.12, delays=0.09/0.01/0.01/0.01, dsn=2.0.0, status=sent (250 2.0.0 <olivia@acme.com> OMoG Saved)
Nov 10 02:26:41 mail postfix/qmgr[22875]: 5D7749497A: removed
Nov 10 02:40:00 mail postfix/smtp[22880]: 418E0949B4: to=<client@[192.0.2.10]>, relay=none, delay=1100, dsn=5.4.1, status=bounced (connect to 192.0.2.10[192.0.2.10]:25: No route to host)
Nov 10 02:41:00 mail postfix/smtp[22881]: 9A8B7C6D5E: to=<kim@example.org>, relay=mx.example.org[203.0.113.5]:25, delay=1.2, dsn=2.0.0, status=sent (250 2.0.0 OK 1762742460 a1b2)
`;
const now = new Date(new Date().getFullYear(), 10, 10, 3, 0, 0).getTime();

test('email log: one entry per message, each recipient\'s latest outcome, refusals too', () => {
  const ms = parseMaillog(LOG, now);
  const byId = Object.fromEntries(ms.filter((m) => m.id).map((m) => [m.id, m]));
  assert.deepEqual(byId['5D7749497A'].recipients.map((r) => [r.to, r.origTo, r.status]), [['olivia@acme.com', 'postmaster@acme.com', 'delivered']]);
  assert.equal(byId['5D7749497A'].messageId, 'logtest-1@globex.com');
  assert.equal(byId['5D7749497A'].from, 'x@globex.com');
  const stuck = byId['418E0949B4'].recipients[0];
  assert.deepEqual([stuck.status, stuck.tries, stuck.response], ['bounced', 2, 'connect to 192.0.2.10[192.0.2.10]:25: No route to host'], 'waited, then bounced');
  const refused = ms.find((m) => !m.id);
  assert.deepEqual([refused.from, refused.recipients[0].to, refused.recipients[0].status], ['x@globex.com', 'nobody-here@acme.com', 'refused']);
  assert.match(refused.recipients[0].response, /^550 5\.1\.1 .*User unknown/);
  assert.equal(ms[0].id, '9A8B7C6D5E', 'newest first');
  assert.equal(new Date(ms[0].at).getMonth(), 10);
});

test('email log: a company sees only mail to or from its domains; search and status', () => {
  const ms = parseMaillog(LOG, now);
  const acme = messagesFor(ms, new Set(['acme.com']));
  assert.deepEqual(acme.map((m) => m.id).sort(), ['418E0949B4', '5D7749497A', null].sort(), 'its sent mail, mail to it, and a refusal at its door');
  assert.equal(acme.some((m) => m.id === '9A8B7C6D5E'), false, 'mail between other domains is not shown');
  assert.equal(messagesFor(ms, new Set(['example.org'])).length, 1);
  assert.deepEqual(messagesFor(ms, new Set(['acme.com']), { q: 'postmaster' }).map((m) => m.id), ['5D7749497A'], 'found by the address it was sent to');
  assert.deepEqual(messagesFor(ms, new Set(['acme.com']), { q: 'logtest-1' }).map((m) => m.id), ['5D7749497A'], 'and by Message-ID');
  assert.deepEqual(messagesFor(ms, new Set(['acme.com']), { status: 'refused' }).length, 1);
});

test('email log: read from the current file and the two newest older ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maillog-'));
  assert.equal(readMaillog(dir), null, 'no log yet');
  fs.writeFileSync(path.join(dir, 'maillog.20261101-000000.gz'), zlib.gzipSync('OLDEST\n'));
  fs.writeFileSync(path.join(dir, 'maillog.20261105-000000.gz'), zlib.gzipSync('OLDER\n'));
  fs.writeFileSync(path.join(dir, 'maillog.20261108-000000.gz'), zlib.gzipSync('OLD\n'));
  fs.writeFileSync(path.join(dir, 'maillog'), 'NOW\n');
  assert.equal(readMaillog(dir), 'OLDER\nOLD\nNOW\n');
});
