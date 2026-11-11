import test from 'node:test';
import assert from 'node:assert/strict';
import { axisOf, summaryOf, dayLabel } from './activechart.js';

test('axisOf rounds up to a tidy top with a few gridlines', () => {
  assert.deepEqual(axisOf(0), { top: 1, ticks: [0, 1] });
  assert.deepEqual(axisOf(3), { top: 5, ticks: [0, 1, 2, 3, 4, 5] });
  assert.deepEqual(axisOf(7), { top: 10, ticks: [0, 2, 4, 6, 8, 10] });
  assert.equal(axisOf(37).top, 50);
  assert.equal(axisOf(120).top, 200);
});

test('summaryOf averages only the days that were counted', () => {
  const days = [{ day: '2026-11-08', active: 0 }, { day: '2026-11-09', active: 4 }, { day: '2026-11-10', active: 2 }];
  assert.deepEqual(summaryOf(days, '2026-11-09'), { average: 3, peak: days[1], counted: 2 });
  assert.equal(summaryOf(days, null).counted, 3);
  assert.equal(summaryOf([{ day: '2026-11-08', active: 0 }], null).peak, null, 'no busiest day when nobody came');
  assert.equal(dayLabel('2026-11-10'), 'Tue 10 Nov');
});
