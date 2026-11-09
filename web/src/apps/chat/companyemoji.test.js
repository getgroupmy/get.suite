import test from 'node:test';
import assert from 'node:assert/strict';
import { splitEmoji, customName } from './companyemoji.js';

test('company emoji in text: only names that exist become pictures', () => {
  const known = new Set(['ship-it', 'party_parrot']);
  assert.deepEqual(splitEmoji('Released :ship-it:!', known), ['Released ', { emoji: 'ship-it' }, '!']);
  assert.deepEqual(splitEmoji(':party_parrot::ship-it:', known), [{ emoji: 'party_parrot' }, { emoji: 'ship-it' }]);
  assert.deepEqual(splitEmoji('Meet at 10:30:45 :nope:', known), ['Meet at 10:30:45 :nope:']);
  assert.deepEqual(splitEmoji('a :x:ship-it: b', known), ['a :x', { emoji: 'ship-it' }, ' b'], 'starts again after a name that isn\'t one');
  assert.deepEqual(splitEmoji('', known), []);
});

test('reaction names', () => {
  assert.equal(customName(':ship-it:'), 'ship-it');
  assert.equal(customName('👍'), null);
  assert.equal(customName(':Bad Name:'), null);
});
