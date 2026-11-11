import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeText, isoDay } from './workloc.js';

test('place text', () => {
  assert.equal(placeText({ place: 'office' }), '🏢 Office');
  assert.equal(placeText({ place: 'other', label: 'Client site' }), '📍 Client site');
  assert.equal(placeText({ place: 'other' }), '📍 Elsewhere');
  assert.equal(placeText(null), '');
  assert.equal(isoDay(new Date(2026, 0, 5)), '2026-01-05');
});

test('today and the next working days', async () => {
  const { comingDays } = await import('./workloc.js');
  const wed = new Date(2026, 10, 11, 15, 30);
  assert.deepEqual(comingDays(5, wed).map(isoDay), ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17']);
  const sat = new Date(2026, 10, 14, 9);
  assert.deepEqual(comingDays(3, sat).map(isoDay), ['2026-11-14', '2026-11-16', '2026-11-17'], 'today even on a weekend, then weekdays');
});
