import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldLines } from './versionfold.js';

const L = (op, n) => ({ op, text: `l${n}`, a: n, b: n });
test('long unchanged runs fold to three lines around each change; short ones stay; an opened one shows', () => {
  const lines = [...Array.from({ length: 10 }, (_, i) => L('=', i)), L('+', 10), ...Array.from({ length: 10 }, (_, i) => L('=', 11 + i))];
  const f = foldLines(lines);
  assert.deepEqual(f[0], { fold: [0, 7] });
  assert.deepEqual(f.slice(1, 4).map((x) => x.text), ['l7', 'l8', 'l9']);
  assert.equal(f[4].op, '+');
  assert.deepEqual(f.at(-1), { fold: [14, 21] });
  assert.equal(foldLines(lines, new Set([0])).filter((x) => x.fold).length, 1);
  assert.equal(foldLines([L('=', 0), L('-', 1), L('=', 2)]).length, 3);
});
