import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, has } from './fold.js';

test('fold and has: accents and case aside', () => {
  assert.equal(fold('Zoë ÅNGSTRÖM'), 'zoe angstrom');
  assert.ok(has('Zoë Brontë', 'zoe BRON'));
  assert.ok(has('Café', 'café'));
  assert.equal(has('Cafe', 'tea'), false);
  assert.equal(fold(null), '');
});
