import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insights, hoursText, taskHoursByDay, deltaText } from './insights.js';

const mon = new Date(2026, 10, 9).getTime(); // Monday
const at = (day, h) => mon + day * 864e5 + h * 36e5;
const me = 'me@acme.com';

test('meetings, focus and other, by day, with people', () => {
  const ev = [
    { start: at(0, 9), end: at(0, 10), role: 'organizer', guests: [{ name: 'Kim', email: 'kim@acme.com', status: 'yes' }] },
    { start: at(0, 10), end: at(0, 12), role: 'organizer', kind: 'focus', guests: [] },
    { start: at(1, 14), end: at(1, 14.5), role: 'guest', my_status: 'yes', organizer: { name: 'Kim', email: 'kim@acme.com' }, guests: [{ name: 'Me', email: me, status: 'yes' }, { name: 'Lee', email: 'lee@acme.com', status: 'yes' }] },
    { start: at(2, 8), end: at(2, 9), role: 'organizer', guests: [] }, // on my own
    { start: at(2, 11), end: at(2, 12), role: 'guest', my_status: 'no', organizer: { name: 'Bo', email: 'bo@acme.com' } }, // declined
    { start: at(3, 0), end: at(4, 0), all_day: 1, role: 'organizer' },
    { start: at(4, 9), end: at(4, 17), kind: 'ooo', role: 'organizer' },
  ];
  const r = insights(ev, mon, mon + 7 * 864e5, me);
  assert.deepEqual([r.meetings, r.focus, r.other, r.total], [1.5, 2, 1, 4.5]);
  assert.deepEqual(r.byDay.slice(0, 3).map((d) => [d.meetings, d.focus, d.other]), [[1, 2, 0], [0.5, 0, 0], [0, 0, 1]]);
  assert.deepEqual(r.people.map((p) => [p.name, p.hours, p.count]), [['Kim', 1.5, 2], ['Lee', 0.5, 1]]);
  assert.equal(r.byDay.length, 7);
});

test('an event across midnight is split between days', () => {
  const r = insights([{ start: at(0, 23), end: at(1, 1), role: 'organizer', guests: [] }], mon, mon + 2 * 864e5, me);
  assert.deepEqual(r.byDay.map((d) => d.other), [1, 1]);
});

test('hours text', () => {
  assert.equal(hoursText(0.5), '30 min');
  assert.equal(hoursText(2), '2 h');
  assert.equal(hoursText(0), '0 h');
});

test('time on tasks for each day: timers split at midnight, logged time on its day', () => {
  const days = insights([], mon, mon + 7 * 864e5, 'me').byDay;
  const tue = days[1].day, h = 36e5;
  const spans = [
    { start: tue + 23 * h, end: tue + 25 * h }, // 1 h Tuesday, 1 h Wednesday
    { start: tue + 9 * h, end: tue + 9.5 * h },
    { start: days[4].day + 12 * h, minutes: 90, logged: true }, // Friday
    { start: mon - 5 * h, end: mon - 4 * h }, // the week before
  ];
  assert.deepEqual(taskHoursByDay(spans, days), [0, 1.5, 1, 0, 1.5, 0, 0]);
  assert.deepEqual(taskHoursByDay(undefined, days), [0, 0, 0, 0, 0, 0, 0]);
});

test('change from last week', () => {
  assert.equal(deltaText(5, 3), '↑ 2 h');
  assert.equal(deltaText(1, 1.5), '↓ 30 min');
  assert.equal(deltaText(2, 2), 'same');
  assert.equal(deltaText(0, 0), null);
  assert.equal(deltaText(0, 4), '↓ 4 h');
  assert.equal(deltaText(2.25, 2), '↑ 18 min', 'to a tenth of an hour, as the tiles show');
});
