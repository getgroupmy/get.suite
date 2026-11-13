import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greeting } from './greeting.js';

test('greeting by time of day', () => {
  assert.equal(greeting(new Date(2026, 0, 1, 8)), 'Good morning');
  assert.equal(greeting(new Date(2026, 0, 1, 13)), 'Good afternoon');
  assert.equal(greeting(new Date(2026, 0, 1, 20)), 'Good evening');
});

test('birthdays and dates card: when and what, soonest first', async () => {
  const { upcoming, whenText, whatText, addDays } = await import('./dates.js');
  assert.equal(whenText('2026-11-10', '2026-11-10'), 'Today');
  assert.equal(whenText('2026-11-11', '2026-11-10'), 'Tomorrow');
  assert.equal(whenText('2026-11-13', '2026-11-10'), 'Friday');
  assert.equal(whenText('2026-11-23', '2026-11-10'), 'Mon 23 Nov');
  assert.equal(whatText({ age: 36 }), 'Birthday (36)');
  assert.equal(whatText({ age: null }), 'Birthday');
  assert.equal(whatText({ label: 'Anniversary', years: 1 }), 'Anniversary (1 year)');
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  const list = upcoming([
    { contact_id: 'b', name: 'Bo', date: '2026-11-12', age: null },
    { contact_id: 'a', name: 'Ann', date: '2026-11-10', age: 36 },
    { contact_id: 'z', name: 'Old', date: '2026-11-09', age: 1 },
  ], '2026-11-10');
  assert.deepEqual(list.map((x) => [x.name, x.when, x.today]), [['Ann', 'Today', true], ['Bo', 'Thursday', false]]);
});

test('keep in touch: how long since', async () => {
  const { sinceText } = await import('./dates.js');
  const now = Date.UTC(2026, 10, 10, 12);
  assert.equal(sinceText(null, now), 'never');
  assert.equal(sinceText(now - 3600e3, now), 'today');
  assert.equal(sinceText(now - 864e5, now), 'yesterday');
  assert.equal(sinceText(now - 5 * 864e5, now), '5 days ago');
  assert.equal(sinceText(now - 35 * 864e5, now), '5 weeks ago');
  assert.equal(sinceText(now - 120 * 864e5, now), '4 months ago');
});

test('a saved chat message in a line', async () => {
  const { savedText } = await import('./savedtext.js');
  assert.equal(savedText({ body: '\n  **Send** the quote\nthanks' }), 'Send the quote');
  assert.equal(savedText({ body: 'x'.repeat(200) }).length, 120);
  assert.equal(savedText({ body: '', files: 2 }), '📎 2 files');
  assert.equal(savedText({ body: '', files: 0, email_subject: 'Northwind order' }), '✉ Northwind order');
  assert.equal(savedText({ body: '' }), 'a message');
});
