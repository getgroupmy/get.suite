import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleDays, shift, title, layoutDay, onDay } from './calmath.js';

const d = (y, m, day, h = 0, min = 0) => new Date(y, m - 1, day, h, min);
const ev = (id, start, end, extra = {}) => ({ id, start: start.getTime(), end: end.getTime(), all_day: 0, ...extra });

test('visible days per view; weeks start on Sunday', () => {
  const thu = d(2026, 11, 5);
  assert.deepEqual(visibleDays('day', d(2026, 11, 5, 15)).map((x) => x.getDate()), [5]);
  assert.deepEqual(visibleDays('week', thu).map((x) => x.getDate()), [1, 2, 3, 4, 5, 6, 7]);
  const month = visibleDays('month', thu);
  assert.equal(month.length, 42);
  assert.equal(month[0].getDay(), 0);
  assert.deepEqual([month[0].getMonth(), month[0].getDate()], [10, 1], 'Nov 2026 starts on a Sunday');
});

test('moving between periods', () => {
  assert.equal(shift('day', d(2026, 11, 30), 1).getDate(), 1);
  assert.equal(shift('week', d(2026, 11, 5), -1).getDate(), 29);
  const feb = shift('month', d(2026, 1, 31), 1);
  assert.deepEqual([feb.getMonth(), feb.getDate()], [1, 28], 'Jan 31 + 1 month = Feb 28');
});

test('titles', () => {
  const t = (...a) => title(...a).replace(/[\s\u2009\u202f]+/g, ' ');
  assert.equal(t('month', d(2026, 11, 5), 'en-US'), 'November 2026');
  assert.equal(t('day', d(2026, 11, 5), 'en-US'), 'Thursday, November 5, 2026');
  assert.equal(t('week', d(2026, 11, 5), 'en-US'), 'Nov 1 – 7, 2026');
  assert.equal(t('week', d(2026, 12, 31), 'en-US'), 'Dec 27, 2026 – Jan 2, 2027');
  assert.equal(t('week', d(2026, 11, 29), 'en-US'), 'Nov 29 – Dec 5, 2026');
});

test('timed events: position, minimum height, clipping to the day', () => {
  const day = d(2026, 11, 5);
  const items = layoutDay([
    ev('a', d(2026, 11, 5, 9), d(2026, 11, 5, 10, 30)),
    ev('short', d(2026, 11, 5, 12), d(2026, 11, 5, 12, 5)),
    ev('overnight', d(2026, 11, 4, 22), d(2026, 11, 5, 2)),
    ev('allday', d(2026, 11, 5), d(2026, 11, 5, 23, 59), { all_day: 1 }),
    ev('other day', d(2026, 11, 6, 9), d(2026, 11, 6, 10)),
  ], day);
  const by = Object.fromEntries(items.map((i) => [i.ev.id, i]));
  assert.deepEqual(Object.keys(by).sort(), ['a', 'overnight', 'short'], 'all-day and other days are not in the grid');
  assert.deepEqual([by.a.top, by.a.height], [540, 90]);
  assert.equal(by.short.height, 20, 'short events stay clickable');
  assert.deepEqual([by.overnight.top, by.overnight.height], [0, 120], 'clipped at midnight');
});

test('overlapping events sit side by side; separate ones use the full width', () => {
  const day = d(2026, 11, 5);
  const items = layoutDay([
    ev('a', d(2026, 11, 5, 9), d(2026, 11, 5, 11)),
    ev('b', d(2026, 11, 5, 10), d(2026, 11, 5, 12)),
    ev('c', d(2026, 11, 5, 11), d(2026, 11, 5, 12)), // overlaps b only: reuses a's column
    ev('d', d(2026, 11, 5, 14), d(2026, 11, 5, 15)),
  ], day);
  const by = Object.fromEntries(items.map((i) => [i.ev.id, [i.col, i.cols]]));
  assert.deepEqual(by, { a: [0, 2], b: [1, 2], c: [0, 2], d: [0, 1] });
});

test('onDay counts zero-length events on their own day', () => {
  const at = ev('z', d(2026, 11, 5, 9), d(2026, 11, 5, 9));
  assert.equal(onDay([at], d(2026, 11, 5)).length, 1);
  assert.equal(onDay([at], d(2026, 11, 4)).length, 0);
});

import { occurrenceStarts, expand, expandAll, occurrenceIndex, describeRule } from './calmath.js';
const times = (ev, to) => occurrenceStarts(ev, to.getTime()).map((t) => { const x = new Date(t); return `${x.getMonth() + 1}/${x.getDate()} ${x.getHours()}:${String(x.getMinutes()).padStart(2, '0')}`; });

test('daily, weekly on weekdays, monthly, yearly', () => {
  const s = d(2026, 11, 2, 9, 30); // Monday
  const one = (rrule, to) => times({ start: s.getTime(), end: s.getTime() + 36e5, rrule }, to);
  assert.deepEqual(one({ freq: 'daily', interval: 2 }, d(2026, 11, 9)), ['11/2 9:30', '11/4 9:30', '11/6 9:30', '11/8 9:30']);
  assert.deepEqual(one({ freq: 'weekly', byday: [1, 2, 3, 4, 5] }, d(2026, 11, 10)), ['11/2 9:30', '11/3 9:30', '11/4 9:30', '11/5 9:30', '11/6 9:30', '11/9 9:30']);
  assert.deepEqual(one({ freq: 'weekly', byday: [0, 4], interval: 2 }, d(2026, 11, 30)), ['11/5 9:30', '11/15 9:30', '11/19 9:30', '11/29 9:30'], 'Sunday before the start is skipped');
  assert.deepEqual(one({ freq: 'daily', count: 3 }, d(2027, 1, 1)), ['11/2 9:30', '11/3 9:30', '11/4 9:30']);
  assert.deepEqual(one({ freq: 'daily', until: d(2026, 11, 4, 23, 59).getTime() }, d(2027, 1, 1)), ['11/2 9:30', '11/3 9:30', '11/4 9:30']);
  const jan31 = d(2026, 1, 31, 8);
  assert.deepEqual(times({ start: jan31.getTime(), end: jan31.getTime(), rrule: { freq: 'monthly' } }, d(2026, 6, 1)), ['1/31 8:00', '3/31 8:00', '5/31 8:00'], 'months without a 31st are skipped');
  const leap = d(2024, 2, 29, 8);
  assert.deepEqual(occurrenceStarts({ start: leap.getTime(), end: leap.getTime(), rrule: { freq: 'yearly' } }, d(2032, 3, 1).getTime()).map((t) => new Date(t).getFullYear()), [2024, 2028, 2032]);
});

test('wall-clock time is kept across clock changes', () => {
  // Whatever the time zone running the test, each occurrence is at 9:00 local time.
  const s = d(2026, 3, 1, 9);
  const starts = occurrenceStarts({ start: s.getTime(), end: s.getTime() + 36e5, rrule: { freq: 'weekly' } }, d(2026, 12, 1).getTime());
  assert.ok(starts.length > 30);
  assert.ok(starts.every((t) => new Date(t).getHours() === 9 && new Date(t).getDay() === s.getDay()));
});

test('expanding: copies with their own times, skipped dates, multi-day and all-day events', () => {
  const s = d(2026, 11, 2, 22), e = d(2026, 11, 3, 1); // 22:00 to 01:00 next day
  const ev = { id: 'x', title: 'Night', start: s.getTime(), end: e.getTime(), rrule: { freq: 'daily' }, exdates: [d(2026, 11, 3, 22).getTime()] };
  const list = expand(ev, d(2026, 11, 3).getTime(), d(2026, 11, 6).getTime());
  assert.deepEqual(list.map((o) => [new Date(o.start).getDate(), new Date(o.end).getDate(), new Date(o.end).getHours()]), [[2, 3, 1], [4, 5, 1], [5, 6, 1]], 'the 3rd is skipped; the 2nd reaches into the range');
  assert.equal(list[0].key, `x@${s.getTime()}`);
  const allDay = { id: 'a', start: d(2026, 3, 27).getTime(), end: d(2026, 3, 27, 23, 59, 59).getTime() + 999, all_day: 1, rrule: { freq: 'daily' } };
  assert.ok(expand(allDay, d(2026, 3, 27).getTime(), d(2026, 4, 3).getTime()).every((o) => new Date(o.start).getHours() === 0 && new Date(o.end).getHours() === 23), 'all-day stays midnight to midnight');
  assert.deepEqual(expandAll([ev, { id: 'y', start: d(2026, 11, 4, 8).getTime(), end: d(2026, 11, 4, 9).getTime() }], d(2026, 11, 4).getTime(), d(2026, 11, 5).getTime()).map((o) => o.id), ['y', 'x']);
});

test('occurrence index and rule descriptions', () => {
  const s = d(2026, 11, 2, 9);
  const ev = { start: s.getTime(), end: s.getTime(), rrule: { freq: 'daily', count: 10 } };
  assert.equal(occurrenceIndex(ev, d(2026, 11, 5, 9).getTime()), 3);
  assert.equal(describeRule(null), 'Does not repeat');
  assert.equal(describeRule({ freq: 'weekly', byday: [1, 2, 3, 4, 5] }, s, 'en-US'), 'Weekly on weekdays');
  assert.equal(describeRule({ freq: 'weekly', byday: [1, 4], interval: 2 }, s, 'en-US'), 'Every 2 weeks on Mon, Thu');
  assert.equal(describeRule({ freq: 'monthly', count: 5 }, s, 'en-US'), 'Monthly, 5 times');
  assert.equal(describeRule({ freq: 'yearly', until: d(2030, 1, 1).getTime() }, s, 'en-US'), 'Yearly, until Jan 1, 2030');
});

import { moveTimes, resizeEnd, shiftWeekdays, snapMinutes } from './calmath.js';

test('dragging: moving keeps the length, resizing keeps a minimum, weekly days follow the move', () => {
  const e = ev('m', d(2026, 11, 5, 9), d(2026, 11, 5, 10, 30));
  const at = ({ start, end }) => [new Date(start).getDate(), new Date(start).getHours(), new Date(start).getMinutes(), new Date(end).getDate(), new Date(end).getHours(), new Date(end).getMinutes()];
  assert.deepEqual(at(moveTimes(e, 1, 45)), [6, 9, 45, 6, 11, 15]);
  assert.deepEqual(at(moveTimes(e, -2, 0)), [3, 9, 0, 3, 10, 30]);
  assert.deepEqual(at(moveTimes(e, 0, 15 * 60)), [6, 0, 0, 6, 1, 30], 'past midnight into the next day');
  const allDay = { start: d(2026, 3, 27).getTime(), end: d(2026, 3, 27, 23, 59).getTime(), all_day: 1 };
  const moved = moveTimes(allDay, 3, 0);
  assert.deepEqual([new Date(moved.start).getHours(), new Date(moved.end).getHours(), new Date(moved.end).getDate()], [0, 23, 30], 'all-day stays midnight to midnight across clock changes');
  assert.deepEqual(at(resizeEnd(e, 30)), [5, 9, 0, 5, 11, 0]);
  assert.deepEqual(at(resizeEnd(e, -200)), [5, 9, 0, 5, 9, 15], 'never shorter than 15 minutes');
  assert.deepEqual(shiftWeekdays({ freq: 'weekly', byday: [1, 3, 6] }, 1).byday, [0, 2, 4]);
  assert.deepEqual(shiftWeekdays({ freq: 'weekly', byday: [1] }, -8).byday, [0]);
  const daily = { freq: 'daily' };
  assert.equal(shiftWeekdays(daily, 2), daily);
  assert.equal(snapMinutes(24, 48), 30);
  assert.equal(snapMinutes(-7, 48), -15);
  assert.equal(snapMinutes(5, 48), 0);
});

test('repeats are worked out in the event\'s own time zone, wherever you look from', () => {
  // Weekly on Thursday 9:00 in Berlin; the clocks go back there on 25 October 2026.
  const ev = { id: 'b', start: Date.UTC(2026, 9, 15, 7), end: Date.UTC(2026, 9, 15, 8), tz: 'Europe/Berlin', rrule: { freq: 'weekly' } };
  const got = expand(ev, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 6)).map((o) => [new Date(o.start).toISOString(), new Date(o.end).toISOString()]);
  assert.deepEqual(got, [
    ['2026-10-15T07:00:00.000Z', '2026-10-15T08:00:00.000Z'],
    ['2026-10-22T07:00:00.000Z', '2026-10-22T08:00:00.000Z'],
    ['2026-10-29T08:00:00.000Z', '2026-10-29T09:00:00.000Z'], // still 9:00 in Berlin
    ['2026-11-05T08:00:00.000Z', '2026-11-05T09:00:00.000Z'],
  ]);
  // Monday 0:30 in Kuala Lumpur is Sunday in UTC: the weekday is the event zone's.
  const kl = { id: 'k', start: Date.UTC(2026, 10, 1, 16, 30), end: Date.UTC(2026, 10, 1, 17), tz: 'Asia/Kuala_Lumpur', rrule: { freq: 'weekly', byday: [1, 3] } };
  assert.deepEqual(occurrenceStarts(kl, Date.UTC(2026, 10, 9)).map((t) => new Date(t).toISOString()), ['2026-11-01T16:30:00.000Z', '2026-11-03T16:30:00.000Z', '2026-11-08T16:30:00.000Z']);
  // An unknown zone falls back to this computer's.
  assert.equal(expand({ ...ev, tz: 'Nowhere/Land' }, Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 20)).length, 1);
});

import { scheduleOf, visibleDays as vd2, shift as sh2, SCHEDULE_DAYS } from './calmath.js';
test('schedule: four weeks from the day; only days with something; all-day first, then by time', () => {
  const start = new Date(2026, 10, 7, 15, 0);
  const days = vd2('schedule', start);
  assert.equal(days.length, SCHEDULE_DAYS);
  assert.equal(days[0].getTime(), new Date(2026, 10, 7).getTime());
  assert.equal(sh2('schedule', start, 1).getDate(), 5, '28 days on: 5 December');
  const at = (d, h) => new Date(2026, 10, d, h).getTime();
  const evs = [
    { title: 'Late', start: at(9, 15), end: at(9, 16) },
    { title: 'Early', start: at(9, 9), end: at(9, 10) },
    { title: 'Holiday', all_day: 1, start: at(9, 0), end: at(10, 0) - 1 },
    { title: 'Out of range', start: at(5, 9), end: at(5, 10) },
  ];
  const s = scheduleOf(evs, days);
  assert.equal(s.length, 1);
  assert.equal(s[0].day.getDate(), 9);
  assert.deepEqual(s[0].items.map((e) => e.title), ['Holiday', 'Early', 'Late']);
});

test('printing: this week (from Monday), this month, four weeks', async () => {
  const { printRange, daysFromTo } = await import('./calmath.js');
  const wed = new Date(2026, 10, 11, 15); // Wednesday 11 November 2026
  const w = printRange('week', wed);
  assert.deepEqual([w.from.getDate(), w.to.getDate(), w.from.getDay()], [9, 15, 1]);
  const m = printRange('month', wed);
  assert.deepEqual([m.from.getDate(), m.to.getDate()], [1, 30]);
  assert.equal(daysFromTo(printRange('four', wed).from, printRange('four', wed).to).length, 28);
  assert.equal(daysFromTo(new Date(2026, 0, 1), new Date(2026, 11, 31)).length, 92, 'at most 92 days');
});

import { moveStart } from './calmath.js';
test('moving the start keeps the length: a late-evening draft moved to 16:00 ends the same day', () => {
  const late = { startDate: '2026-11-08', startTime: '23:00', endDate: '2026-11-09', endTime: '00:00', all_day: false };
  assert.deepEqual(moveStart(late, { startTime: '16:00' }), { ...late, startTime: '16:00', endDate: '2026-11-08', endTime: '17:00' });
  assert.deepEqual(moveStart(late, { startDate: '2026-11-12' }), { ...late, startDate: '2026-11-12', endDate: '2026-11-13', endTime: '00:00' });
  const days = { startDate: '2026-11-08', startTime: '', endDate: '2026-11-10', endTime: '', all_day: true };
  assert.deepEqual(moveStart(days, { startDate: '2026-11-20' }), { ...days, startDate: '2026-11-20', endDate: '2026-11-22' });
});

import { nthWeekdayOf, weekdayInMonth } from './calmath.js';
test('monthly on a weekday: the second Monday, the last Friday', () => {
  assert.equal(nthWeekdayOf(2026, 10, 2, 1), 9); // Nov 2026: Mondays 2, 9, 16, 23, 30
  assert.equal(nthWeekdayOf(2026, 10, -1, 1), 30);
  assert.equal(nthWeekdayOf(2026, 1, -1, 5), 27); // Feb 2026's last Friday
  assert.deepEqual(weekdayInMonth(new Date(2026, 10, 9, 10).getTime()), { wd: 1, nth: 2, last: false });
  assert.deepEqual(weekdayInMonth(new Date(2026, 10, 30, 10).getTime()), { wd: 1, nth: 5, last: true });
  assert.deepEqual(weekdayInMonth(new Date(2026, 10, 27, 10).getTime()), { wd: 5, nth: 4, last: true });
  const second = { start: new Date(2026, 10, 9, 10).getTime(), end: new Date(2026, 10, 9, 11).getTime(), rrule: { freq: 'monthly', nth: 2, wd: 1 } };
  assert.deepEqual(times(second, new Date(2027, 2, 1)), ['11/9 10:00', '12/14 10:00', '1/11 10:00', '2/8 10:00']);
  const last = { start: new Date(2026, 10, 27, 16).getTime(), end: new Date(2026, 10, 27, 17).getTime(), rrule: { freq: 'monthly', nth: -1, wd: 5, interval: 2, count: 3 } };
  assert.deepEqual(times(last, new Date(2028, 0, 1)), ['11/27 16:00', '1/29 16:00', '3/26 16:00']);
  // A start that isn't itself one (the 3rd Monday asked from the 1st): the first one is that month's, if still to come.
  const later = { start: new Date(2026, 10, 2, 9).getTime(), end: new Date(2026, 10, 2, 10).getTime(), rrule: { freq: 'monthly', nth: 3, wd: 1, count: 2 } };
  assert.deepEqual(times(later, new Date(2027, 6, 1)), ['11/16 9:00', '12/21 9:00']);
  assert.equal(describeRule(second.rrule, second.start, 'en-GB'), 'Monthly on the second Monday');
  assert.equal(describeRule(last.rrule, last.start, 'en-GB'), 'Every 2 months on the last Friday, 3 times');
  // Moved by dragging: it takes the new date's place in its month.
  assert.deepEqual(shiftWeekdays(second.rrule, 8, new Date(2026, 10, 17, 10).getTime()), { freq: 'monthly', nth: 3, wd: 2 });
  assert.deepEqual(shiftWeekdays(last.rrule, -1, new Date(2026, 10, 26, 16).getTime()), { freq: 'monthly', nth: -1, wd: 4, interval: 2, count: 3 });
  assert.deepEqual(shiftWeekdays(second.rrule, 0, second.start), second.rrule);
});

test('year view: every day of the year, a year at a time, and a count of events per day', async () => {
  const { visibleDays, shift, title, eventsPerDay } = await import('./calmath.js');
  const days = visibleDays('year', new Date(2028, 5, 15));
  assert.equal(days.length, 366, 'a leap year');
  assert.equal(days[0].getTime(), new Date(2028, 0, 1).getTime());
  assert.equal(days.at(-1).getTime(), new Date(2028, 11, 31).getTime());
  assert.equal(visibleDays('year', new Date(2027, 0, 1)).length, 365);
  assert.equal(shift('year', new Date(2028, 1, 29), 1).getTime(), new Date(2029, 1, 28).getTime(), '29 Feb to 28 Feb');
  assert.equal(title('year', new Date(2027, 3, 1)), '2027');
  const t = (m, d, h = 0) => new Date(2027, m, d, h).getTime();
  const counts = eventsPerDay([
    { start: t(0, 5, 9), end: t(0, 5, 10) },
    { start: t(0, 5, 0), end: t(0, 8, 0) }, // all day 5, 6 and 7 January
    { start: t(2, 1, 9), end: t(2, 1, 9) }, // no length: still its day
    { start: t(11, 31, 22), end: new Date(2028, 0, 2).getTime() }, // runs past the year: cut off
  ], visibleDays('year', new Date(2027, 0, 1)));
  assert.equal(counts.get(t(0, 5)), 2);
  assert.equal(counts.get(t(0, 7)), 1);
  assert.equal(counts.get(t(0, 8)), undefined);
  assert.equal(counts.get(t(2, 1)), 1);
  assert.equal(counts.get(t(11, 31)), 1);
});
