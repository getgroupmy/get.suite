import { test } from 'node:test';
import assert from 'node:assert/strict';
import { muteChoices } from './mute.js';

test('how long to mute: an hour, 8 hours, tomorrow at 8:00, a week, or until unmuted', () => {
  const now = new Date(2026, 10, 13, 22, 30);
  const c = muteChoices(now);
  assert.deepEqual(c.map((x) => x[0]), ['For 1 hour', 'For 8 hours', 'Until tomorrow morning', 'For a week', 'Until I unmute']);
  assert.equal(c[0][1] - now.getTime(), 3600e3);
  assert.equal(c[1][1] - now.getTime(), 8 * 3600e3);
  assert.deepEqual(new Date(c[2][1]), new Date(2026, 10, 14, 8, 0));
  assert.equal(c[3][1] - now.getTime(), 7 * 864e5);
  assert.equal(c[4][1], null);
  // At the end of a month: the next day's morning.
  assert.deepEqual(new Date(muteChoices(new Date(2026, 10, 30, 9))[2][1]), new Date(2026, 11, 1, 8, 0));
});
