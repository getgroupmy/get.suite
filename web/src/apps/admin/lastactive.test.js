import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastActiveText, inactive } from './lastactive.js';

test('last active in words, and who counts as inactive', () => {
  const now = Date.UTC(2026, 10, 7, 12);
  assert.equal(lastActiveText(null, now), 'Never');
  assert.equal(lastActiveText(now - 36e5, now), 'Today');
  assert.equal(lastActiveText(now - 30 * 36e5, now), 'Yesterday');
  assert.equal(lastActiveText(now - 12 * 864e5, now), '12 days ago');
  assert.equal(lastActiveText(now - 100 * 864e5, now), '3 months ago');
  assert.equal(lastActiveText(now - 800 * 864e5, now), '2 years ago');
  assert.equal(inactive({ last_active: now - 91 * 864e5 }, now), true);
  assert.equal(inactive({ last_active: now - 10 * 864e5 }, now), false);
  assert.equal(inactive({ last_active: null }, now), true, 'never signed in');
  assert.equal(inactive({ last_active: null, disabled: 1 }, now), false, 'disabled accounts are already dealt with');
});
