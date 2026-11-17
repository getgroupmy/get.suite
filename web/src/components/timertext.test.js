import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timerText } from './timertext.js';

test('a running timer in words', () => {
  const t = 1e12;
  assert.equal(timerText({ since: t, until: t + 25 * 60e3 }, t + 60e3), '24 min left');
  assert.equal(timerText({ since: t, until: t + 25 * 60e3 }, t + 30 * 60e3), '0 min left');
  assert.equal(timerText({ since: t }, t + 8.5 * 60e3), '8 min');
  assert.equal(timerText({ since: t }, t + 65 * 60e3), '1 h 05');
});
