import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emojiQuery, matchEmoji } from './emojitype.js';

test('":" and a word at the start or after a space is an emoji being typed', () => {
  assert.deepEqual(emojiQuery('Great job :thu', 14), { from: 10, query: 'thu' });
  assert.deepEqual(emojiQuery(':party', 6), { from: 0, query: 'party' });
  assert.deepEqual(emojiQuery('(:smi', 5), { from: 1, query: 'smi' });
});

test('times, "Note: x", URLs and a lone letter are not', () => {
  assert.equal(emojiQuery('at 10:30', 8), null);
  assert.equal(emojiQuery('Note: ab', 8), null);
  assert.equal(emojiQuery('see http://x', 12), null);
  assert.equal(emojiQuery('a :t', 4), null, 'two letters at least');
  assert.equal(emojiQuery('a :12', 5), null, 'starts with a letter');
});

test('matching emoji: by name or search words; words joined by _ or -; at most eight', () => {
  assert.ok(matchEmoji('thu').some((e) => e.char === '👍'));
  assert.ok(matchEmoji('thumbs_up').some((e) => e.char === '👍'));
  assert.ok(matchEmoji('heart').length <= 8);
  assert.deepEqual(matchEmoji('zzqx'), []);
});

test('company emoji (Chat) come first, as :name:', () => {
  const l = matchEmoji('ship', 8, [{ name: 'ship-it', img: '/x' }, { name: 'party-parrot', img: '/y' }]);
  assert.deepEqual(l[0], { char: ':ship-it:', name: 'ship-it', img: '/x' });
  assert.ok(!l.some((e) => e.name === 'party-parrot'));
});
