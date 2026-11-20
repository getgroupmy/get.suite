import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceTyped, replacementFor } from './replacements.js';

const subs = [{ from: 'addr', to: '1 High Street, Leeds' }, { from: 'brb', to: 'be right back' }];

test('the word before a space or punctuation just typed is replaced, the caret after the mark', () => {
  assert.deepEqual(replaceTyped('Send to addr ', 13, subs), { value: 'Send to 1 High Street, Leeds ', caret: 29 });
  assert.deepEqual(replaceTyped('brb.', 4, subs), { value: 'be right back.', caret: 14 });
  assert.deepEqual(replaceTyped('ok brb, then', 7, subs), { value: 'ok be right back, then', caret: 17 }, 'in the middle of the text');
});

test('nothing else: another word, part of a word, a letter typed, no replacements', () => {
  assert.equal(replaceTyped('address ', 8, subs), null);
  assert.equal(replaceTyped('xaddr ', 6, subs), null);
  assert.equal(replaceTyped('addr', 4, subs), null);
  assert.equal(replaceTyped('addr ', 5, []), null);
  assert.equal(replaceTyped(' ', 1, subs), null);
  assert.equal(replacementFor('Addr', subs), null, 'exactly as typed');
});
