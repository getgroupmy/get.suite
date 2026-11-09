import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balanceText, daysText } from './timeoffmath.js';

test('vacation balance in words', () => {
  assert.equal(balanceText({ year: 2026, days: 25, used: 15, pending: 3, left: 7 }), '7 of 25 vacation days left in 2026 (3 waiting for an answer)');
  assert.equal(balanceText({ year: 2026, days: 1, used: 0, pending: 0, left: 1 }), '1 of 1 vacation day left in 2026');
  assert.equal(balanceText({ year: 2026, days: 10, used: 12, pending: 0, left: -2 }), '0 of 10 vacation days left in 2026', 'never below nothing');
  assert.equal(balanceText({ year: 2026, days: null, used: 4, pending: 0, left: null }), null, 'no limit');
  assert.equal(balanceText(undefined), null);
});

test('working days in words, half days too', () => {
  assert.equal(daysText(3), '3 working days');
  assert.equal(daysText(1), '1 working day');
  assert.equal(daysText(0.5), 'half a working day');
  assert.equal(daysText(2.5), '2.5 working days');
  assert.equal(balanceText({ year: 2027, days: 10, used: 0.5, pending: 0, left: 9.5 }), '9.5 of 10 vacation days left in 2027');
});
