import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMOJI_GROUPS, ALL_EMOJI, searchEmoji } from './emoji.js';

test('emoji list: no duplicates, every one named', () => {
  const chars = ALL_EMOJI.map((e) => e.char);
  assert.equal(new Set(chars).size, chars.length);
  assert.ok(ALL_EMOJI.every((e) => e.name && e.group));
  assert.ok(EMOJI_GROUPS.length >= 6 && ALL_EMOJI.length > 250);
});

test('search matches the start of each word typed, in names and extra words', () => {
  const chars = (q) => searchEmoji(q).map((e) => e.char);
  assert.deepEqual(chars('thu up'), ['👍']);
  assert.ok(chars('thanks').includes('🙏'), 'extra words count');
  assert.ok(chars('PARTY').includes('🎉'), 'any case');
  assert.deepEqual(chars('umbs'), [], 'only from the start of a word');
  assert.equal(searchEmoji('  ').length, ALL_EMOJI.length);
  assert.ok(chars('check').includes('✅'));
});
