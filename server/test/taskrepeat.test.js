import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDue } from '../src/taskrepeat.js';

test('next due date for each kind of repeat', () => {
  assert.equal(nextDue('2026-11-07', 'daily'), '2026-11-08');
  assert.equal(nextDue('2026-11-06', 'weekdays'), '2026-11-09'); // Friday → Monday
  assert.equal(nextDue('2026-11-07', 'weekdays'), '2026-11-09'); // Saturday → Monday
  assert.equal(nextDue('2026-11-07', 'weekly'), '2026-11-14');
  assert.equal(nextDue('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(nextDue('2024-02-29', 'yearly'), '2025-02-28');
  assert.equal(nextDue('2026-12-15', 'monthly'), '2027-01-15');
  assert.equal(nextDue('2026-11-07', null), null);
  assert.equal(nextDue(null, 'daily'), null);
  assert.equal(nextDue('2026-11-07', 'hourly'), null);
});

test('missed occurrences are skipped, keeping the schedule', () => {
  assert.equal(nextDue('2026-11-01', 'daily', '2026-11-07'), '2026-11-07');
  assert.equal(nextDue('2026-11-02', 'weekly', '2026-11-20'), '2026-11-23'); // still Mondays
  assert.equal(nextDue('2026-08-31', 'monthly', '2026-11-07'), '2026-11-30'); // month end kept from the 31st
  assert.equal(nextDue('2026-11-07', 'daily', '2026-11-01'), '2026-11-08'); // done early: the next one after it
});

test('custom repeats: every N days, weeks (on chosen weekdays), months or years', async () => {
  const { cleanRepeat } = await import('../src/taskrepeat.js');
  assert.equal(cleanRepeat('every:1:week'), 'weekly', 'plain ones by their simple names');
  assert.equal(cleanRepeat('every:1:week:5,1,2,3,4'), 'weekdays');
  assert.equal(cleanRepeat('every:2:week:4,1,1'), 'every:2:week:1,4', 'days sorted, repeats dropped');
  assert.equal(cleanRepeat('every:3:month:1'), 'every:3:month', 'weekdays only mean something for weeks');
  for (const bad of ['every:0:day', 'every:100:day', 'every:2:fortnight', 'every:2:week:7', 'hourly', '']) assert.equal(cleanRepeat(bad), null, bad);
  // 2026-11-09 is a Monday.
  assert.equal(nextDue('2026-11-09', 'every:3:day'), '2026-11-12');
  assert.equal(nextDue('2026-11-09', 'every:2:week'), '2026-11-23');
  assert.equal(nextDue('2026-11-09', 'every:1:week:1,4'), '2026-11-12', 'Monday → Thursday');
  assert.equal(nextDue('2026-11-12', 'every:1:week:1,4'), '2026-11-16', 'Thursday → next Monday');
  assert.equal(nextDue('2026-11-12', 'every:2:week:1,4'), '2026-11-23', 'every other week: the Monday after next');
  assert.equal(nextDue('2026-11-09', 'every:2:week:3'), '2026-11-11', 'a later weekday in the same week counts');
  assert.equal(nextDue('2026-01-31', 'every:3:month'), '2026-04-30', 'the 31st becomes the month’s last day');
  assert.equal(nextDue('2024-02-29', 'every:2:year'), '2026-02-28');
  assert.equal(nextDue('2026-11-09', 'every:2:week:1', '2026-12-01'), '2026-12-07', 'missed ones are skipped, keeping the rhythm');
});
