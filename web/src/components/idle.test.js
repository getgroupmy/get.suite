import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaySpan, awayText, AWAY_MS } from './idle.js';

const t0 = Date.UTC(2026, 10, 17, 9, 0), min = 60e3;

test('away from a running timer: long enough, while it ran', () => {
  const run = { since: t0 };
  assert.deepEqual(awaySpan(run, t0 + 20 * min, t0 + 50 * min), { from: t0 + 20 * min, to: t0 + 50 * min });
  assert.equal(awaySpan(run, t0 + 45 * min, t0 + 50 * min), null, 'five minutes is nothing');
  assert.equal(awaySpan(null, t0, t0 + 50 * min), null, 'no timer');
  assert.equal(awaySpan({ since: t0, until: t0 + 90 * min }, t0, t0 + 50 * min), null, 'a focus session ends by itself');
  assert.deepEqual(awaySpan({ since: t0 + 30 * min }, t0, t0 + 45 * min), { from: t0 + 30 * min, to: t0 + 45 * min }, 'only since it started');
  assert.equal(awaySpan({ since: t0 + 40 * min }, t0, t0 + 45 * min), null, 'started just now');
  assert.equal(awaySpan(run, 0, t0 + 50 * min), null, 'never active here yet');
  assert.deepEqual(awaySpan(run, t0, t0 + 2000, 1000), { from: t0, to: t0 + 2000 }, 'a shorter threshold');
  assert.equal(AWAY_MS, 10 * min);
});

test('away in words', () => {
  const fmt = (t) => new Date(t).toISOString().slice(11, 16);
  assert.equal(awayText({ from: t0 + 5 * min, to: t0 + 50 * min }, fmt), '09:05 – 09:50 (45 min)');
  assert.equal(awayText({ from: t0, to: t0 + 95 * min }, fmt), '09:00 – 10:35 (1 h 35)');
});
