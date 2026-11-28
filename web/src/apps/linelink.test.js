import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineLink, lineFrom } from './linelink.js';

test('a link to a line, and reading it back', () => {
  const l = lineLink('https://ws.example', 'abc_1-2', 12);
  assert.equal(l, 'https://ws.example/drive?preview=abc_1-2&line=12');
  assert.equal(lineFrom(new URL(l).searchParams.get('line')), 12);
});
test('anything that isn’t a line number is no line', () => {
  for (const v of [null, undefined, '', '0', '-3', '1.5', '12abc', ' 12', '99999999', 'javascript:1']) assert.equal(lineFrom(v), null, String(v));
  assert.equal(lineFrom('9999999'), 9999999);
});
