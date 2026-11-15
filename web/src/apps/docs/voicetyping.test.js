import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spokenToText } from './voicetyping.js';

test('spoken punctuation becomes punctuation, with the spacing tidied', () => {
  assert.equal(spokenToText('hello comma how are you question mark'), 'Hello, how are you?');
  assert.equal(spokenToText('the plan colon two weeks full stop'), 'The plan: two weeks.');
  assert.equal(spokenToText('see the notes open bracket attached close bracket period'), 'See the notes (attached).');
  assert.equal(spokenToText('he said open quote yes close quote exclamation mark'), 'He said “yes”!');
});

test('capitals: at the start, after a sentence and a new line; not mid-sentence', () => {
  assert.equal(spokenToText('first point period second point'), 'First point. Second point');
  assert.equal(spokenToText('and then we left', 'We arrived'), ' and then we left');
  assert.equal(spokenToText('And then we left', 'We arrived'), ' and then we left', 'the browser’s own capital, mid-sentence');
  assert.equal(spokenToText('I think so', 'Well,'), ' I think so', 'but not "I"');
  assert.equal(spokenToText('next one', 'Done.'), ' Next one');
  assert.equal(spokenToText('new paragraph thanks everyone'), '\n\nThanks everyone');
  assert.equal(spokenToText('line one new line line two'), 'Line one\nLine two');
});

test('spacing against what was there already', () => {
  assert.equal(spokenToText('comma then more', 'Yes'), ', then more');
  assert.equal(spokenToText('more', 'Yes '), 'more');
  assert.equal(spokenToText('', 'x'), '');
  assert.equal(spokenToText('period', 'End'), '.');
});
