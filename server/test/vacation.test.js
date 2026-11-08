import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vacationForAway } from '../src/mail/vacation.js';

test('an Out of office event as an auto-reply: its days in its time zone, and its message', () => {
  // All day, 22 to 26 December in Kuala Lumpur (stored as local midnight to the last moment of the 26th).
  const kl = (d, h = 0) => Date.UTC(2026, 11, d, h - 8);
  const v = vacationForAway({ title: 'Out of office', start: kl(22), end: kl(27) - 1, all_day: 1, description: '' }, 'Asia/Kuala_Lumpur');
  assert.equal(v.start_date, '2026-12-22'); assert.equal(v.end_date, '2026-12-26');
  assert.match(v.body, /back on Sunday 27 December/);
  assert.equal(v.subject, 'Out of office');
  // Timed, ending at midnight: the last day is the day before.
  const t = vacationForAway({ title: 'Conference', start: Date.UTC(2026, 10, 10, 9), end: Date.UTC(2026, 10, 12), all_day: 0, description: 'At the trade fair; urgent things to sam@acme.com' }, 'UTC');
  assert.equal(t.start_date, '2026-11-10'); assert.equal(t.end_date, '2026-11-11');
  assert.equal(t.body, 'At the trade fair; urgent things to sam@acme.com');
  assert.equal(t.subject, 'Out of office: Conference');
});
