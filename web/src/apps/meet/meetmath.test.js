import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCode, columnsFor, whoIsHere, elapsed } from './meetmath.js';

test('parseCode accepts codes, spaced codes and links', () => {
  assert.equal(parseCode('abc-defg-hij'), 'abc-defg-hij');
  assert.equal(parseCode(' ABC DEFG HIJ '), 'abc-defg-hij');
  assert.equal(parseCode('abcdefghij'), 'abc-defg-hij');
  assert.equal(parseCode('https://work.example.com/meet/xyz-wxyz-abc?x=1'), 'xyz-wxyz-abc');
  assert.equal(parseCode('abc-defg'), null);
  assert.equal(parseCode('abc-defg-hi1'), null);
});

test('grid and text helpers', () => {
  assert.deepEqual([1, 2, 4, 5, 8].map(columnsFor), [1, 2, 2, 3, 3]);
  assert.equal(whoIsHere([]), 'No one else is here yet');
  assert.equal(whoIsHere(['Mia', 'Max']), 'Mia and Max are here');
  assert.equal(whoIsHere(['Mia', 'Max', 'Ann']), 'Mia, Max and 1 other are here');
  assert.equal(whoIsHere(['Mia', 'Max', 'Ann', 'Bo']), 'Mia, Max and 2 others are here');
  assert.equal(elapsed(5000), '0:05');
  assert.equal(elapsed(3723000), '1:02:03');
});

test('spotlight: the pinned person, else whoever presents, else nobody', async () => {
  const { spotlightOf } = await import('./meetmath.js');
  const me = { id: 'me', me: true, state: {} }, kim = { id: 'k', state: {} }, ann = { id: 'a', state: { screen: true } };
  assert.equal(spotlightOf([me, kim], null), null);
  assert.equal(spotlightOf([me, kim, ann], null), 'a', 'a presenter is shown big');
  assert.equal(spotlightOf([me, kim, ann], 'k'), 'k', 'pinning wins');
  assert.equal(spotlightOf([me, ann], 'gone'), 'a', 'a pin on someone who left is let go');
  assert.equal(spotlightOf([{ ...me, state: { screen: true } }, kim], null), null, 'not your own screen');
  assert.equal(spotlightOf([me], 'me'), null, 'alone: no spotlight');
});

test('speaking: how loud, and who is talking (held briefly between words)', async () => {
  const { loudness, speakingNow, SPEAKING_LEVEL } = await import('./meetmath.js');
  assert.equal(loudness(new Uint8Array(64).fill(128)), 0, 'silence');
  const loud = Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 160 : 96));
  assert.ok(loudness(loud) > SPEAKING_LEVEL);
  assert.ok(loudness(Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 129 : 127))) < SPEAKING_LEVEL, 'background hiss is not speech');
  assert.equal(loudness(null), 0);
  assert.deepEqual([...speakingNow({ a: 1000, b: 200 }, 1500)], ['a']);
  assert.deepEqual([...speakingNow({ a: 1000 }, 1800)], [], 'quiet for long enough: no ring');
});

test('the host’s countdown', async () => {
  const { countdown } = await import('./meetmath.js');
  assert.equal(countdown(null), null);
  assert.deepEqual(countdown({ ends_at: 100000 }, 100000 - 272500), { left: '4:33', up: false, soon: false });
  assert.deepEqual(countdown({ ends_at: 100000 }, 100000 - 9000), { left: '0:09', up: false, soon: true });
  assert.deepEqual(countdown({ ends_at: 100000 }, 100500), { left: '0:00', up: true, soon: false });
});
