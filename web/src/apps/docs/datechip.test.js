import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateText, isDate, isoDay, matchDates, dateWhen } from './datechip.js';

test('date chips: shown the same everywhere, offered for @today, @tomorrow, @date', () => {
  assert.equal(dateText('2026-11-09'), '9 Nov 2026');
  assert.equal(dateText('2027-01-31'), '31 Jan 2027');
  assert.equal(dateText('2026-02-30'), 'No date');
  assert.equal(dateText(null), 'No date');
  assert.ok(isDate('2028-02-29') && !isDate('2027-02-29') && !isDate('2026-1-5'));
  const now = new Date(2026, 11, 31, 23, 30);
  assert.equal(isoDay(now), '2026-12-31');
  assert.equal(isoDay(now, 1), '2027-01-01');
  assert.deepEqual(matchDates('to', now).map((d) => [d.label, d.date]), [['Today', '2026-12-31'], ['Tomorrow', '2027-01-01']]);
  assert.deepEqual(matchDates('dat', now).map((d) => [d.label, d.pick]), [['Date…', true]]);
  assert.deepEqual(matchDates('y', now).map((d) => d.date), ['2026-12-30']);
  assert.deepEqual(matchDates('', now), [], 'a bare @ offers people only');
  assert.deepEqual(matchDates('olivia', now), []);
  assert.equal(dateWhen('2026-12-30', now), 'past');
  assert.equal(dateWhen('2026-12-31', now), 'today');
  assert.equal(dateWhen('2027-01-01', now), 'future');
});
