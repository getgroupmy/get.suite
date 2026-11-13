import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printDocument, printDocuments } from './mailprint.js';

test('the printed page: headers escaped, body, attachments, and no scripts allowed', () => {
  const m = { from: { name: 'Bob <evil>', address: 'bob@x.com' }, to: [{ address: 'ann@acme.com' }], cc: [], date: '2026-11-07T10:00:00Z',
    subject: 'Invoice <42>', html: '<p>Hello <b>there</b></p>', attachments: [{ filename: 'inv.pdf' }] };
  const page = printDocument(m);
  assert.match(page, /<h1>Invoice &lt;42&gt;<\/h1>/);
  assert.match(page, /Bob &lt;evil&gt; &lt;bob@x.com&gt;/);
  assert.match(page, /<p>Hello <b>there<\/b><\/p>/);
  assert.match(page, /Attachments: inv.pdf/);
  assert.match(page, /default-src 'none'/);
  assert.doesNotMatch(page, /<th>Cc:/, 'empty headers left out');
  assert.doesNotMatch(page, /img-src[^"]*https:/, 'remote images stay hidden');
  assert.match(printDocument(m, { images: true }), /img-src data: cid: https: http:/);
  assert.match(printDocument({ subject: '', text: 'a < b' }), /<pre>a &lt; b<\/pre>/);
});

test('several messages on one printout: each its own page, the same safe page (no scripts, no remote pictures)', () => {
  const html = printDocuments([{ subject: 'One <b>', text: 'first', from: { address: 'a@x' } }, { subject: 'Two', html: '<p>second</p>' }]);
  assert.match(html, /<title>2 messages<\/title>/);
  assert.equal((html.match(/<section class="msg">/g) || []).length, 2);
  assert.match(html, /One &lt;b&gt;/);
  assert.match(html, /<p>second<\/p>/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.match(html, /section\.msg \+ section\.msg\{break-before:page\}/);
});
