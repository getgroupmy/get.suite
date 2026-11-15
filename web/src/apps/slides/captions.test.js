import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionText, keepRecent } from './captions.js';

test('what was said, then what is still being heard, one line', () => {
  assert.equal(captionText(['Welcome everyone', 'to the review'], 'of the quarter'), 'Welcome everyone to the review of the quarter');
  assert.equal(captionText([], '  hello  there '), 'hello there');
  assert.equal(captionText([], ''), '');
});

test('long speech: only the latest words, starting at a word', () => {
  const said = Array.from({ length: 40 }, (_, i) => `word${i}`);
  const t = captionText([said.join(' ')], '', 60);
  assert.ok(t.length <= 60, t);
  assert.ok(t.endsWith('word39'));
  assert.match(t, /^word\d+ /, 'starts at a whole word');
});

test('only the last few phrases are kept', () => {
  assert.deepEqual(keepRecent(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 3), ['f', 'g', 'h']);
});
