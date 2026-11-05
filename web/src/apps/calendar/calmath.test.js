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
