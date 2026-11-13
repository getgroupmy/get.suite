import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRemind } from '../src/noterepeat.js';

const at = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString();

test('daily, weekly; the same wall clock across a clock change', () => {
  assert.equal(iso(nextRemind(at('2026-11-13T08:00:00Z'), 'daily', 'UTC')), '2026-11-14T08:00:00.000Z');
  assert.equal(iso(nextRemind(at('2026-11-13T08:00:00Z'), 'weekly', 'UTC')), '2026-11-20T08:00:00.000Z');
  // 8:00 in London before and after the clocks go back (25 Oct 2026): 07:00Z then 08:00Z.
  assert.equal(iso(nextRemind(at('2026-10-24T07:00:00Z'), 'daily', 'Europe/London')), '2026-10-25T08:00:00.000Z');
  assert.equal(nextRemind(at('2026-11-13T08:00:00Z'), 'never', 'UTC'), null);
});

test('weekdays skip the weekend; monthly keeps the day, or the last one', () => {
  assert.equal(iso(nextRemind(at('2026-11-13T09:00:00Z'), 'weekdays', 'UTC')), '2026-11-16T09:00:00.000Z', 'Friday → Monday');
  assert.equal(iso(nextRemind(at('2026-11-16T09:00:00Z'), 'weekdays', 'UTC')), '2026-11-17T09:00:00.000Z');
  assert.equal(iso(nextRemind(at('2026-01-31T09:00:00Z'), 'monthly', 'UTC')), '2026-02-28T09:00:00.000Z');
  assert.equal(iso(nextRemind(at('2026-12-15T09:00:00Z'), 'monthly', 'UTC')), '2027-01-15T09:00:00.000Z', 'into the next year');
  assert.equal(iso(nextRemind(at('2026-11-13T23:30:00Z'), 'daily', 'Asia/Kuala_Lumpur')), '2026-11-14T23:30:00.000Z', '07:30 local');
});

test('after a long time away: the next one still to come, not one in the past', () => {
  assert.equal(iso(nextRemind(at('2026-11-01T08:00:00Z'), 'daily', 'UTC', at('2026-11-13T10:00:00Z'))), '2026-11-14T08:00:00.000Z');
  assert.equal(iso(nextRemind(at('2026-11-02T08:00:00Z'), 'weekly', 'UTC', at('2026-11-13T10:00:00Z'))), '2026-11-16T08:00:00.000Z');
});
