import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mboxEntry, mboxName, asctime } from '../src/mail/mbox.js';

test('mbox: each message starts with a From line; From lines inside are escaped (mboxrd)', () => {
  const src = Buffer.from('Subject: Hi\r\nFrom: Kim <kim@acme.com>\r\n\r\nFrom here on, prices go up.\r\n>From the archive\r\nbye\r\n');
  const out = mboxEntry(src, { from: 'kim@acme.com', date: new Date(Date.UTC(2026, 10, 9, 8, 5, 3)) }).toString('latin1');
  assert.equal(out, 'From kim@acme.com Mon Nov  9 08:05:03 2026\nSubject: Hi\nFrom: Kim <kim@acme.com>\n\n>From here on, prices go up.\n>>From the archive\nbye\n\n');
  assert.match(mboxEntry('x', { from: 'not an address' }).toString(), /^From MAILER-DAEMON Thu Jan  1 00:00:00 1970\nx\n\n$/, 'no sender or date: placeholders');
  const bytes = Buffer.from([0x53, 0x3a, 0x20, 0xe9, 0x0d, 0x0a]);
  assert.deepEqual([...mboxEntry(bytes).subarray(-4)], [0x20, 0xe9, 0x0a, 0x0a], '8-bit bytes are kept as they are');
  assert.equal(asctime(new Date(Date.UTC(2026, 0, 15, 23, 0, 0))), 'Thu Jan 15 23:00:00 2026');
});

test('mbox: folder file names', () => {
  assert.equal(mboxName({ path: 'INBOX', delimiter: '/' }), 'Inbox.mbox');
  assert.equal(mboxName({ path: 'Projects/Acme: 2026', delimiter: '/' }), 'Projects/Acme_ 2026.mbox');
  assert.equal(mboxName({ path: 'Archive.Old', delimiter: '.' }), 'Archive/Old.mbox');
});
