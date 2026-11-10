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

test('mbox: reading back what was written, mboxo too, with dates and flags', async () => {
  const { readMbox, countMbox, flagsOf, dateOfFromLine } = await import('../src/mail/mbox.js');
  const { Readable } = await import('node:stream');
  const one = mboxEntry('Subject: One\r\nMessage-ID: <1@x>\r\n\r\nFrom here on.\r\n>From the archive\r\n', { from: 'a@x.com', date: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) });
  const two = Buffer.from('From b@x.com Sat Feb 14 10:00:00 2026\nSubject: Two\nStatus: O\nX-Status: F\n\nLast line, no blank after');
  const file = Buffer.concat([one, two]);
  // In small pieces, as a stream would come.
  const pieces = () => Readable.from(Array.from({ length: Math.ceil(file.length / 7) }, (_, i) => file.subarray(i * 7, i * 7 + 7)));
  const got = [];
  for await (const m of readMbox(pieces())) got.push(m);
  assert.equal(got.length, 2);
  assert.equal(got[0].source.toString(), 'Subject: One\r\nMessage-ID: <1@x>\r\n\r\nFrom here on.\r\n>From the archive\r\n');
  assert.equal(got[0].date.toISOString(), '2026-01-02T03:04:05.000Z');
  assert.equal(got[1].source.toString(), 'Subject: Two\r\nStatus: O\r\nX-Status: F\r\n\r\nLast line, no blank after\r\n');
  assert.equal(await countMbox(pieces()), 2);
  assert.deepEqual(flagsOf(got[0].source), ['\\Seen'], 'no status: read');
  assert.deepEqual(flagsOf(got[1].source), ['\\Flagged'], 'Status without R: unread; X-Status F: starred');
  assert.deepEqual(flagsOf(Buffer.from('X-Gmail-Labels: Inbox,Starred,Unread\r\n\r\nx')), ['\\Flagged']);
  assert.equal(dateOfFromLine('From x Mon Nov  9 08:05:03 +0000 2026'), null, 'an odd form: no date (the message keeps its own)');
  assert.equal(dateOfFromLine('From x Mon Nov  9 08:05:03 2026').toISOString(), '2026-11-09T08:05:03.000Z');
});
