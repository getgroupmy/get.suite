import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrowHead } from './drawmath.js';

test('an arrow head points back along its line, one side each', () => {
  const r = (p) => p.map((v) => Math.round(v * 100) / 100);
  const [a, b] = arrowHead(0, 0, 100, 0, 10, Math.PI / 4); // pointing right
  assert.deepEqual(r(a), [92.93, 7.07]);
  assert.deepEqual(r(b), [92.93, -7.07]);
  const [c, d] = arrowHead(0, 0, 0, 50, 10, Math.PI / 4); // pointing down
  assert.deepEqual(r(c), [-7.07, 42.93]);
  assert.deepEqual(r(d), [7.07, 42.93]);
});
