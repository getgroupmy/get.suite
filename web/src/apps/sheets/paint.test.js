import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFormats, paintFormats } from './paint.js';

const formats = { A1: { b: true, fill: '#ffff00' }, B1: { num: 'currency' }, D4: { i: true } };

test('copying a block of formats', () => {
  assert.deepEqual(copyFormats(formats, { c1: 0, r1: 0, c2: 2, r2: 0 }), [[{ b: true, fill: '#ffff00' }, { num: 'currency' }, null]]);
});

test('painting replaces the formatting; a block repeats across the target', () => {
  const pattern = copyFormats(formats, { c1: 0, r1: 0, c2: 1, r2: 0 });
  const out = paintFormats(formats, { c1: 2, r1: 3, c2: 5, r2: 4 }, pattern);
  assert.deepEqual(out.C4, { b: true, fill: '#ffff00' });
  assert.deepEqual(out.D4, { num: 'currency' }, 'italic replaced');
  assert.deepEqual(out.E5, { b: true, fill: '#ffff00' });
  assert.deepEqual(out.F5, { num: 'currency' });
  assert.deepEqual(out.A1, formats.A1, 'the source is untouched');
  const plain = paintFormats(out, { c1: 2, r1: 3, c2: 3, r2: 3 }, [[null]]);
  assert.equal(plain.C4, undefined); assert.equal(plain.D4, undefined);
  assert.deepEqual(plain.E5, { b: true, fill: '#ffff00' });
});
