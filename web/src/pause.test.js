import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pauseChoices, isPaused } from './pause.js';

test('pause choices: 30 minutes, 1 and 2 hours, tomorrow morning', () => {
  const now = new Date(2026, 10, 7, 16, 0);
  const c = pauseChoices(now);
  assert.deepEqual(c.map(([l]) => l), ['For 30 minutes', 'For 1 hour', 'For 2 hours', 'Until tomorrow, 9:00']);
  assert.equal(c[3][1], new Date(2026, 10, 8, 9, 0).getTime());
  assert.equal(isPaused(), false);
});
