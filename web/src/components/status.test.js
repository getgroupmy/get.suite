import { test } from 'node:test';
import assert from 'node:assert/strict';
import { untilFor, untilText, statusLine } from './status.js';

test('clear-after times', () => {
  const sat = new Date(2026, 10, 7, 10, 0); // Saturday 7 Nov 2026, 10:00
  assert.equal(untilFor('30m', sat), sat.getTime() + 30 * 60e3);
  assert.equal(untilFor('today', sat), new Date(2026, 10, 8).getTime());
  assert.equal(untilFor('week', sat), new Date(2026, 10, 9).getTime(), 'end of Sunday');
  assert.equal(untilFor('week', new Date(2026, 10, 8, 9)), new Date(2026, 10, 9).getTime(), 'on Sunday: tonight');
  assert.equal(untilFor('week', new Date(2026, 10, 9, 9)), new Date(2026, 10, 16).getTime(), 'Monday: next Sunday night');
  assert.equal(untilFor('', sat), null);
});

test('describing when it clears', () => {
  const now = new Date(2026, 10, 7, 10, 0);
  assert.equal(untilText(null, now), '');
  assert.equal(untilText(new Date(2026, 10, 8).getTime(), now), 'until the end of today');
  assert.match(untilText(new Date(2026, 10, 7, 15, 30).getTime(), now), /^until 3:30/);
  assert.match(untilText(new Date(2026, 10, 9).getTime(), now), /^until the end of Sun/);
  assert.equal(statusLine({ emoji: '🌴', text: 'On holiday' }), '🌴 On holiday');
  assert.equal(statusLine({ emoji: null, text: 'Busy' }), 'Busy');
  assert.equal(statusLine(null), '');
});
