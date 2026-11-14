import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesBlock, sweepInboxes } from '../src/mail/sweep.js';

test('which From addresses a block covers', () => {
  assert.ok(matchesBlock('Payroll@EvilPay.com', 'payroll@evilpay.com'));
  assert.ok(!matchesBlock('other@evilpay.com', 'payroll@evilpay.com'));
  assert.ok(matchesBlock('a@evilpay.com', 'evilpay.com'));
  assert.ok(matchesBlock('a@mail.evilpay.com', 'evilpay.com'), 'subdomains too');
  assert.ok(!matchesBlock('a@notevilpay.com', 'evilpay.com'), 'not a domain that only ends the same');
  assert.ok(!matchesBlock('', 'evilpay.com'));
});

test('sweep: only matching mail moves, to each person’s Junk, marked read; someone unreachable is listed', async () => {
  // Pretend mailboxes: uid → from address.
  const boxes = {
    'kim@acme.com': { junk: 'Junk', inbox: { 1: 'payroll@evilpay.com', 2: 'boss@acme.com', 3: 'x@notevilpay.com', 4: 'hr@mail.evilpay.com' } },
    'leo@acme.com': { junk: 'Spam', inbox: { 7: 'friend@example.com' } },
  };
  const done = [];
  const client = (who) => ({
    list: async () => [{ path: boxes[who].junk, specialUse: '\\Junk' }, { path: 'INBOX' }],
    // IMAP's FROM search is a substring match: it finds notevilpay.com too.
    search: async ({ from }) => Object.entries(boxes[who].inbox).filter(([, a]) => a.includes(from)).map(([u]) => Number(u)),
    async *fetch(set) { for (const u of set.split(',')) yield { uid: Number(u), envelope: { from: [{ address: boxes[who].inbox[u] }] } }; },
    messageFlagsAdd: async (set, flags) => done.push([who, 'flag', set, flags.join()]),
    messageMove: async (set, to) => done.push([who, 'move', set, to]),
  });
  const io = {
    withClient: async (u, fn) => { if (u.username === 'gone@acme.com') throw new Error('no mailbox'); return fn(client(u.username)); },
    withFolder: async (u, folder, fn) => fn(client(u.username)),
  };
  const r = await sweepInboxes([{ username: 'kim@acme.com' }, { username: 'leo@acme.com' }, { username: 'gone@acme.com' }], 'evilpay.com', io);
  assert.deepEqual(r, { people: 1, messages: 2, failed: ['gone@acme.com'] });
  assert.deepEqual(done, [['kim@acme.com', 'flag', '1,4', '\\Seen'], ['kim@acme.com', 'move', '1,4', 'Junk']]);
});
