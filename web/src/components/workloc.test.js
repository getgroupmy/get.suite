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
