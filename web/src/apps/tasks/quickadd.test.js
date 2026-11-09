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

test('quick add: #tags', () => {
  const r = parseQuickAdd('Call Acme #client #Sales tomorrow #client', { today: '2026-11-08' });
  assert.equal(r.title, 'Call Acme');
  assert.deepEqual(r.tags, ['client', 'sales']);
  assert.equal(r.due, '2026-11-09');
  assert.deepEqual(r.found.filter((f) => f.kind === 'tag').map((f) => f.text), ['#client', '#sales']);
  const n = parseQuickAdd('Fix issue #42', { today: '2026-11-08' });
  assert.equal(n.title, 'Fix issue #42');
  assert.deepEqual(n.tags, []);
});

test('quick add: custom repeats', async () => {
  const { repeatText } = await import('./taskmath.js');
  const today = '2026-11-09'; // a Monday
  const p = (s) => parseQuickAdd(s, { today });
  assert.equal(p('Pay rent every 2 weeks').repeat, 'every:2:week');
  assert.equal(p('Water ferns every other day').repeat, 'every:2:day');
  assert.equal(p('Review budget every 3 months').repeat, 'every:3:month');
  const gym = p('Gym every tue and thursday');
  assert.deepEqual([gym.title, gym.repeat, gym.due], ['Gym', 'every:1:week:2,4', '2026-11-10'], 'starts on the first of those days');
  const standup = p('Standup every 2 weeks on mon, wed');
  assert.deepEqual([standup.title, standup.repeat, standup.due], ['Standup', 'every:2:week:1,3', '2026-11-09']);
  assert.equal(p('Report every week').repeat, 'weekly', 'plain ones as before');
  assert.equal(p('Timesheet every mon,tue,wed,thu,fri').repeat, 'weekdays');
  assert.equal(repeatText('every:2:week:1,4'), 'Every 2 weeks on Mon, Thu');
  assert.equal(repeatText('every:1:week:2,4'), 'Every week on Tue, Thu');
  assert.equal(repeatText('every:3:month'), 'Every 3 months');
  assert.equal(repeatText('monthly'), 'Monthly');
});
