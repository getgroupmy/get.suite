import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanWords, MAX_WORDS } from '../src/mail/attachprefs.js';

test('attachment words: trimmed, lower case, one each; from a list or lines and commas', () => {
  assert.deepEqual(cleanWords(['  Anlage ', 'spec  sheet', 'anlage', '']), ['anlage', 'spec sheet']);
  assert.deepEqual(cleanWords('Bilaga\nliite, Vedlegg'), ['bilaga', 'liite', 'vedlegg']);
  assert.deepEqual(cleanWords(undefined), []);
});

test('attachment words: too short, too long or too many are refused', () => {
  assert.throws(() => cleanWords(['x']), /2 to 40/);
  assert.throws(() => cleanWords(['y'.repeat(41)]), /2 to 40/);
  assert.throws(() => cleanWords(Array.from({ length: MAX_WORDS + 1 }, (_, i) => `word${i}`)), /Up to 20/);
  assert.equal(cleanWords(Array.from({ length: MAX_WORDS }, (_, i) => `word${i}`)).length, MAX_WORDS);
});
