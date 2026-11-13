import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { emailCard } from '../src/routes/webmail.js';

const raw = (headers, body) => `${headers.join('\r\n')}\r\n\r\n${body}`;

test('a card of an email: who, subject, date, the new text without the quoted history, attachment names', async () => {
  const p = await simpleParser(raw([
    'From: Kim Park <kim@acme.com>', 'To: Olivia <olivia@acme.com>, Lee <lee@acme.com>', 'Cc: a@x.com, b@x.com', 'Subject: Re: Northwind order',
    'Date: Thu, 12 Nov 2026 09:30:00 +0000', 'Message-ID: <abc123@acme.com>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=b1',
  ], ['--b1', 'Content-Type: text/plain; charset=utf-8', '', 'They confirmed 40 units.\r\n\r\n\r\n\r\nShip Friday?', '',
    'On Wed, 11 Nov 2026, Olivia <olivia@acme.com> wrote:', '> How many units?', '',
    '--b1', 'Content-Type: application/pdf; name="order.pdf"', 'Content-Disposition: attachment; filename="order.pdf"', 'Content-Transfer-Encoding: base64', '', 'JVBERi0=', '--b1--', ''].join('\r\n')));
  const c = emailCard(p);
  assert.deepEqual(c.from, { name: 'Kim Park', address: 'kim@acme.com' });
  assert.deepEqual(c.to.map((x) => x.address), ['olivia@acme.com', 'lee@acme.com']);
  assert.equal(c.cc_count, 2);
  assert.equal(c.subject, 'Re: Northwind order');
  assert.equal(c.date, Date.UTC(2026, 10, 12, 9, 30));
  assert.equal(c.text, 'They confirmed 40 units.\n\nShip Friday?', 'no quoted history, no runs of blank lines');
  assert.deepEqual(c.attachments, ['order.pdf']);
  assert.equal(c.message_id, '<abc123@acme.com>', 'to find it again and answer it');
});

test('an HTML-only email gives its text; a long one is cut at a word', async () => {
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
  const p = await simpleParser(raw(['From: a@x.com', 'Subject: Long', 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8'], `<p>Hello <b>team</b></p><p>${words}</p>`));
  const c = emailCard(p);
  assert.match(c.text, /^Hello team/);
  assert.ok(c.text.length <= 1501, String(c.text.length));
  assert.match(c.text, /word\d+…$/, 'ends on a whole word');
  assert.deepEqual(c.attachments, []);
  assert.equal(c.subject, 'Long');
  assert.deepEqual(c.to, []);
  assert.equal(c.message_id, null, 'none in the email');
});
