import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../src/textdiff.js';

const ops = (d) => d.lines.map((l) => `${l.op}${l.text}`);

test('a changed line in the middle: removed then added, the rest the same, with line numbers', () => {
  const d = diffLines('port: 80\nname: shop\nmode: dev\n', 'port: 80\nname: store\nmode: dev\n');
  assert.deepEqual(ops(d), ['=port: 80', '-name: shop', '+name: store', '=mode: dev']);
  assert.deepEqual([d.added, d.removed, d.rough], [1, 1, false]);
  assert.deepEqual(d.lines.map((l) => [l.a, l.b]), [[1, 1], [2, null], [null, 2], [3, 3]]);
});

test('lines added and removed in several places keep the common lines in order', () => {
  const d = diffLines('a\nb\nc\nd\ne', 'a\nc\nd\nX\ne\nf');
  assert.deepEqual(ops(d), ['=a', '-b', '=c', '=d', '+X', '=e', '+f']);
  assert.deepEqual(d.lines.at(-1), { op: '+', text: 'f', a: null, b: 6 });
});

test('the same text, an empty one, and Windows line endings', () => {
  assert.deepEqual([diffLines('x\ny', 'x\r\ny\r\n').added, diffLines('x\ny', 'x\r\ny\r\n').removed], [0, 0]);
  assert.deepEqual(ops(diffLines('', 'new\n')), ['+new']);
  assert.deepEqual(ops(diffLines('old', '')), ['-old']);
});

test('too big to compare closely: all removed then all added, marked rough', () => {
  const a = Array.from({ length: 2500 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 2500 }, (_, i) => `b${i}`).join('\n');
  const d = diffLines(a, b);
  assert.equal(d.rough, true);
  assert.deepEqual([d.removed, d.added], [2500, 2500]);
});
