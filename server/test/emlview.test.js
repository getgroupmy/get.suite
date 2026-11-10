import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emlView, htmlText } from '../src/mail/emlview.js';

const eml = (body, extra = '') => Buffer.from([
  'From: "Bob Sender" <bob@sender.example>', 'To: kim@acme.com, Ann <ann@acme.com>', 'Cc: lee@acme.com', 'Date: Tue, 10 Nov 2026 08:59:58 +0000', 'Subject: =?UTF-8?Q?Invoice_=E2=82=AC120?=', extra, body,
].filter((x) => x !== '').join('\r\n'));

test('an attached email: who, when, subject, text and its attachments', async () => {
  const v = await emlView(eml(['MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '', '--b', 'Content-Type: text/plain; charset=utf-8', '', 'Please pay by Friday.', '--b', 'Content-Type: application/pdf; name="invoice.pdf"', 'Content-Disposition: attachment; filename="invoice.pdf"', 'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-1.4 fake').toString('base64'), '--b--', ''].join('\r\n')));
  assert.deepEqual(v.from, { name: 'Bob Sender', address: 'bob@sender.example' });
  assert.deepEqual(v.to.map((x) => x.address), ['kim@acme.com', 'ann@acme.com']);
  assert.deepEqual(v.cc.map((x) => x.address), ['lee@acme.com']);
  assert.equal(v.date, Date.UTC(2026, 10, 10, 8, 59, 58));
  assert.equal(v.subject, 'Invoice €120');
  assert.equal(v.text.trim(), 'Please pay by Friday.');
  assert.deepEqual(v.attachments, [{ filename: 'invoice.pdf', size: 13, contentType: 'application/pdf' }]);
});

test('an HTML-only email is shown as text, scripts and styles left out', async () => {
  const v = await emlView(eml(['MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', '<html><head><style>p{color:red}</style></head><body><script>alert(1)</script><p>Hello &amp; welcome</p><ul><li>One</li><li>Two</li></ul></body></html>'].join('\r\n')));
  assert.match(v.text, /^Hello & welcome\s+\W*One\s+\W*Two$/);
  assert.doesNotMatch(v.text, /alert|color:red/);
  assert.equal(htmlText('a<br>b&nbsp;&lt;c&gt;&#8364;'), 'a\nb <c>€');
});
