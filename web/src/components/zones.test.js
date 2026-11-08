import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeIn, zoneName, cityOf, allZones } from './zones.js';

test('time in another zone', () => {
  const noonUtc = Date.UTC(2026, 10, 9, 12, 0);
  assert.match(timeIn(noonUtc, 'Asia/Tokyo'), /^9\s?PM$|^21$/);
  assert.match(timeIn(noonUtc, 'Asia/Kolkata'), /5:30/);
  assert.match(zoneName('Asia/Kolkata', noonUtc), /GMT\+5:30|IST/);
  assert.equal(cityOf('Asia/Kuala_Lumpur'), 'Kuala Lumpur');
  assert.ok(allZones().includes('Asia/Tokyo'));
});
