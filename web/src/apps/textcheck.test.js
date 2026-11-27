import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkText } from './textcheck.js';

test('valid JSON, empty files and other kinds pass', () => {
  assert.equal(checkText('a.json', '{"a": [1, 2]}'), null);
  assert.equal(checkText('a.json', '  \n'), null);
  assert.equal(checkText('a.yaml', 'not: [valid'), null);
  assert.equal(checkText('a.txt', '{'), null);
});

test('broken JSON: where it breaks, by line and column, and the offset', () => {
  const text = '{\n  "chair": 40,\n  "desk": 80,\n}\n'; // a trailing comma
  const r = checkText('prices.json', text);
  assert.ok(r);
  assert.equal(r.line, 4);
  assert.equal(r.column, 1);
  assert.equal(text[r.at], '}');
  assert.match(r.message, /^This isn’t valid JSON \(line 4, column 1\): /);
  const r2 = checkText('x.json', '{"a": 1 "b": 2}');
  assert.deepEqual([r2.line, r2.column], [1, 9]);
});
