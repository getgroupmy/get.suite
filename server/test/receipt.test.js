import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { receiptRequest, buildReceipt } from '../src/mail/receipt.js';

const msg = (extra = '') => simpleParser(`From: Raj <raj@globex.example.com>\r\nTo: olivia@acme.com\r\nSubject: Café quote\r\nMessage-ID: <q1@globex.example.com>\r\nDate: Sat, 07 Nov 2026 10:00:00 +0000\r\n${extra}\r\nHello`);

test('a receipt is offered only when asked, and never to yourself', async () => {
  assert.equal(receiptRequest(await msg('Disposition-Notification-To: Raj <raj@globex.example.com>\r\n'), ['olivia@acme.com']), 'raj@globex.example.com');
  assert.equal(receiptRequest(await msg(), ['olivia@acme.com']), null);
  assert.equal(receiptRequest(await msg('Disposition-Notification-To: olivia@acme.com\r\n'), ['olivia@acme.com']), null);
});

test('the receipt names the original message and says it was displayed', async () => {
  const p = await msg('Disposition-Notification-To: raj@globex.example.com\r\n');
  const raw = buildReceipt(p, { from: { name: 'Olivia Owner', address: 'olivia@acme.com' }, to: 'raj@globex.example.com', host: 'mail.acme.com', now: new Date(Date.UTC(2026, 10, 7, 11)) });
  const r = await simpleParser(raw);
  assert.equal(r.subject, 'Read: Café quote');
  assert.equal(r.to.value[0].address, 'raj@globex.example.com');
  assert.match(r.headers.get('content-type').value, /multipart\/report/);
  assert.match(raw, /Original-Message-ID: <q1@globex\.example\.com>/);
  assert.match(raw, /Disposition: manual-action\/MDN-sent-manually; displayed/);
  assert.match(r.text, /was displayed on Sat, 07 Nov 2026 11:00:00 GMT/);
  assert.doesNotMatch(raw, /\r\n\r\n.*\r\nBcc/);
});
