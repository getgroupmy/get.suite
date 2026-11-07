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
