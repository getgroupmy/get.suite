import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationText, conversationHtml, pollLine, cardLines } from '../src/chatexport.js';

const at = (iso) => Date.parse(iso);
const msgs = [
  { who: 'Ann', at: at('2026-11-09T08:05:00Z'), body: 'Morning!\nAll set?', files: [], replies: [{ who: 'Ben', at: at('2026-11-09T08:07:00Z'), body: 'Yes', edited: true, files: ['plan.pdf'] }] },
  { who: 'Ben', at: at('2026-11-10T23:30:00Z'), body: '', files: ['photo.jpg'], poll: { question: 'Lunch?', options: [{ text: 'Pizza', votes: [{}, {}] }, { text: 'Sushi', votes: [] }] } },
];

test('plain text: days, times in the reader\'s zone, replies indented, files and polls', () => {
  const t = conversationText('#launch', msgs, { tz: 'Europe/London', now: at('2026-11-11T10:00:00Z') });
  assert.match(t, /^#launch\nDownloaded 11 Nov 2026, 10:00 \(Europe\/London\) · 2 messages\n/);
  assert.match(t, /— Monday, 9 November 2026 —\n\[9 Nov 2026, 08:05\] Ann:\n  Morning!\n  All set\?\n    ↳ \[9 Nov 2026, 08:07\] Ben \(edited\):\n      Yes\n      📎 plan\.pdf/);
  assert.match(t, /— Tuesday, 10 November 2026 —\n\[10 Nov 2026, 23:30\] Ben:\n  \n  📎 photo\.jpg\n  📊 Lunch\? — Pizza 2, Sushi 0/);
  // Another zone moves the late message to the next day.
  assert.match(conversationText('#launch', msgs, { tz: 'Asia/Tokyo' }), /— Wednesday, 11 November 2026 —\n\[11 Nov 2026, 08:30\] Ben:/);
  assert.match(conversationText('#launch', msgs, { tz: 'Not/AZone' }), /\(UTC\)/, 'a zone that isn\'t one: UTC');
});

test('HTML: escaped, replies set in', () => {
  const h = conversationHtml('<b>DM</b>', [{ who: 'Eve <script>', at: at('2026-11-09T08:00:00Z'), body: '<img src=x onerror=alert(1)>', files: [], replies: [] }]);
  assert.ok(!h.includes('<script>') && !h.includes('<img src=x'));
  assert.match(h, /<title>&lt;b&gt;DM&lt;\/b&gt;<\/title>/);
  assert.match(conversationHtml('#x', msgs), /class="m r"/);
  assert.equal(pollLine(null), '');
});

test('contacts and emails shared in a message, as lines (and on the page)', () => {
  assert.deepEqual(cardLines({ contact: { name: 'Kim Park', title: 'Buyer', company: 'Northwind', email: 'kim@nw.example', phone: '+60 3 1234' } }), ['👤 Kim Park · Buyer, Northwind · kim@nw.example · +60 3 1234']);
  assert.deepEqual(cardLines({ email: { from: { name: '', address: 'a@x.com' }, subject: '', text: 'One\n\nTwo', attachments: [] } }), ['✉ Email “(no subject)” from a@x.com', '   One', '', '   Two']);
  assert.deepEqual(cardLines({}), []);
  const html = conversationHtml('#x', [{ who: 'Ann', at: at('2026-11-09T08:05:00Z'), body: '', files: [], cards: ['✉ Email “<Q3>” from a@x.com', '   hi'] }]);
  assert.match(html, /✉ Email “&lt;Q3&gt;” from a@x\.com\n   hi/);
});
