import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordProblem, isExpired, rulesText, DEFAULT_RULES } from '../src/passwordrules.js';
import { readablePassword } from '../src/userimport.js';

test('password rules: length, letters and numbers, a symbol, nothing easy to guess', () => {
  assert.equal(passwordProblem('short', DEFAULT_RULES), 'Password must be at least 8 characters');
  assert.equal(passwordProblem('password123', DEFAULT_RULES), null, 'the defaults are just a length');
  const strict = { min: 12, mix: true, symbol: true, common: true, max_days: 90 };
  assert.match(passwordProblem('abcdefghijkl', strict), /letters and numbers/);
  assert.match(passwordProblem('abcdefghijk1', strict), /symbol/);
  assert.match(passwordProblem('Password123!', strict), /easy to guess/);
  assert.match(passwordProblem('Summer2026!!', strict), /easy to guess/);
  assert.match(passwordProblem('12345678xyz!', strict), /easy to guess/);
  assert.match(passwordProblem('kimpark2026!', strict, { email: 'kim.park@acme.com', name: 'Kim Park' }), /own name/);
  assert.equal(passwordProblem('blue-Kettle-49-river', strict, { email: 'kim@acme.com', name: 'Kim Park' }), null);
  assert.equal(passwordProblem('x'.repeat(201), DEFAULT_RULES), 'Password is too long');
  for (let i = 0; i < 50; i++) assert.equal(passwordProblem(readablePassword(), { ...strict, min: 14, common: false }), null, 'generated passwords always pass');
});

test('password expiry, and the rules in words', () => {
  const day = 864e5, t = Date.UTC(2026, 10, 8);
  assert.equal(isExpired({ max_days: 90 }, t - 91 * day, t), true);
  assert.equal(isExpired({ max_days: 90 }, t - 89 * day, t), false);
  assert.equal(isExpired({ max_days: 0 }, 0, t), false);
  assert.equal(rulesText({ min: 12, mix: true, symbol: true, common: true }), 'Use at least 12 characters, with letters and numbers and a symbol, and nothing easy to guess.');
  assert.equal(rulesText(DEFAULT_RULES), 'Use at least 8 characters.');
});
