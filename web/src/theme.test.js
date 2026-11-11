import test from 'node:test';
import assert from 'node:assert/strict';
import { onAccent } from './theme.js';

test('onAccent: white on a dark company colour, near-black on a light one', () => {
  assert.equal(onAccent('#1a73e8'), '#fff', 'the usual blue');
  assert.equal(onAccent('#b71c1c'), '#fff');
  assert.equal(onAccent('#8ab4f8'), '#1f1f1f', 'the light dark-mode blue');
  assert.equal(onAccent('#fbbc04'), '#1f1f1f', 'yellow');
  assert.equal(onAccent('#ffffff'), '#1f1f1f');
});
