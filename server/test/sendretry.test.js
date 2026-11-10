import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendWithRetry, SETTLE_MS } from '../src/mail/imap.js';

const refused = () => Object.assign(new Error('Can\'t send mail - all recipients were rejected: 553 5.7.1 <fay@acme.test>: Sender address rejected: not owned by user fay@acme.test'), { responseCode: 553, response: '553 5.7.1 <fay@acme.test>: Sender address rejected: not owned by user fay@acme.test' });
const failing = (n, err = refused) => { let calls = 0; const fn = async () => { calls++; if (calls <= n) throw err(); return 'sent'; }; fn.calls = () => calls; return fn; };
const waits = [1, 1, 1, 1];

test('sending right after the mail setup changed: refused while the mail server catches up, then sent', async () => {
  const send = failing(2);
  assert.equal(await sendWithRetry(send, { waits, changedAt: () => Date.now() }), 'sent');
  assert.equal(send.calls(), 3);
  const auth = failing(1, () => Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 }));
  assert.equal(await sendWithRetry(auth, { waits, changedAt: () => Date.now() }), 'sent', 'a brand-new account signing in too');
  const unknown = failing(1, () => Object.assign(new Error('Can\'t send mail - all recipients were rejected: 550 5.1.1 <kim@acme.test>: Recipient address rejected: User unknown in virtual mailbox table'), { responseCode: 550 }));
  assert.equal(await sendWithRetry(unknown, { waits, changedAt: () => Date.now() }), 'sent', 'to someone just added');
});

test('not retried: long after a change, other refusals, or once the waits run out', async () => {
  const late = failing(1);
  await assert.rejects(sendWithRetry(late, { waits, changedAt: () => Date.now() - SETTLE_MS - 1000 }), /not owned by user/);
  assert.equal(late.calls(), 1);
  const other = failing(1, () => Object.assign(new Error('550 mailbox full'), { responseCode: 550, response: '550 5.2.2 mailbox full' }));
  await assert.rejects(sendWithRetry(other, { waits, changedAt: () => Date.now() }), /mailbox full/);
  assert.equal(other.calls(), 1);
  const never = failing(99);
  await assert.rejects(sendWithRetry(never, { waits, changedAt: () => Date.now() }), /not owned by user/);
  assert.equal(never.calls(), waits.length + 1);
});
