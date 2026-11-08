import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickAdd } from './quickadd.js';

const today = '2026-11-08'; // a Sunday
const people = [{ id: 'k', name: 'Kim Park', username: 'kim@acme.com' }, { id: 'l', name: 'Lee Fox', username: 'lfox@acme.com' }];
const p = (t) => parseQuickAdd(t, { today, people });

test('quick add: dates', () => {
  assert.deepEqual([p('Call Kim tomorrow').title, p('Call Kim tomorrow').due], ['Call Kim', '2026-11-09']);
  assert.equal(p('Report today').due, today);
  assert.equal(p('Pay rent on Friday').due, '2026-11-13');
  assert.equal(p('Gym sunday').due, '2026-11-15', 'the same weekday is next week');
  assert.equal(p('Plan next week').due, '2026-11-09');
  assert.equal(p('Renew in 3 days').due, '2026-11-11');
  assert.equal(p('Renew in 2 weeks').due, '2026-11-22');
  assert.equal(p('Audit 2026-12-01').due, '2026-12-01');
  assert.equal(p('Party 24 Dec').due, '2026-12-24');
  assert.equal(p('Party Dec 24th').due, '2026-12-24');
  assert.equal(p('Taxes 31 jan').due, '2027-01-31', 'next year once passed');
  assert.equal(p('Taxes 5/1').due, '2027-01-05', 'day/month');
  assert.equal(p('Call by fri').due, '2026-11-13');
  const sat = p('Sat with Kim');
  assert.equal(sat.due, null, 'short day names need "on"');
  assert.equal(sat.title, 'Sat with Kim');
  assert.equal(p('Book 30 Feb').due, null, 'no such day');
});

test('quick add: times, repeats, importance and people', () => {
  const t = p('Send invoice tomorrow 3pm every month !');
  assert.deepEqual({ title: t.title, due: t.due, time: t.due_time, repeat: t.repeat, important: t.important }, { title: 'Send invoice', due: '2026-11-09', time: '15:00', repeat: 'monthly', important: true });
  assert.equal(p('Standup at 9:30am').due_time, '09:30');
  assert.equal(p('Standup at 9:30am').due, today, 'a time alone means today');
  assert.equal(p('Call 14:05').due_time, '14:05');
  assert.equal(p('Lunch at 12pm').due_time, '12:00');
  assert.equal(p('Water plants daily').repeat, 'daily');
  assert.equal(p('Water plants daily').due, today, 'a repeat needs a day');
  assert.equal(p('Timesheet every weekday').repeat, 'weekdays');
  assert.equal(p('Ask @kim about it').assignee_id, 'k');
  assert.equal(p('Ask @kim about it').title, 'Ask about it');
  assert.equal(p('Ask @Lee Fox now').assignee_id, 'l');
  assert.equal(p('Ask @Lee Fox now').title, 'Ask now');
  assert.equal(p('Email @nobody').assignee_id, null);
  assert.equal(p('Email @nobody').title, 'Email @nobody');
  assert.equal(p('Version 2.0 notes').due_time, null);
  assert.deepEqual(p('Fix it!').important, false, 'only a separate !');
  assert.deepEqual(p('tomorrow').title, 'tomorrow', 'nothing left: kept as typed');
  assert.deepEqual(p('tomorrow').due, null);
  assert.deepEqual(p('Send invoice tomorrow 3pm every month !').found.map((f) => f.kind), ['due', 'time', 'important', 'repeat']);
});
