import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { countText, countDoc, readingMinutes, readingTime, counterText } from './wordcount.js';

const schema = getSchema([StarterKit]);
const doc = (...paras) => schema.nodeFromJSON({ type: 'doc', content: paras.map((p) => (p === null ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text: p }] })) });

test('counting plain text', () => {
  assert.deepEqual(countText('Hello, world — it’s 2026.\nSecond line'), { words: 6, characters: 36, noSpaces: 31, paragraphs: 2 });
  assert.deepEqual(countText(''), { words: 0, characters: 0, noSpaces: 0, paragraphs: 0 });
  assert.equal(countText('e-mail 3.5 % & —').words, 2, 'symbols alone are not words');
});

test('counting a document, or the selected part of it', () => {
  const d = doc('The quick brown fox', null, 'jumps over the lazy dog');
  assert.deepEqual(countDoc(d), { words: 9, characters: 42, noSpaces: 35, paragraphs: 2 });
  // "brown fox" .. "jumps": from inside the first paragraph to inside the third.
  const from = 1 + 'The quick '.length, to = d.content.size - 1 - ' over the lazy dog'.length;
  assert.equal(d.textBetween(from, to, '|'), 'brown fox||jumps');
  assert.deepEqual(countDoc(d, from, to), { words: 3, characters: 14, noSpaces: 13, paragraphs: 2 });
});

test('reading time and the counter', () => {
  assert.equal(readingMinutes(0), 0);
  assert.equal(readingMinutes(10), 1);
  assert.equal(readingMinutes(2300), 10);
  assert.equal(readingTime(230 * 65), '1 h 5 min');
  assert.equal(readingTime(230 * 120), '2 h');
  assert.equal(counterText({ words: 1 }), '1 word');
  assert.equal(counterText({ words: 1340 }, { words: 12 }), '12 of 1,340 words');
});

test('word count goal: progress and done', async () => {
  const { goalProgress } = await import('./wordcount.js');
  assert.deepEqual(goalProgress(350, 1000), { text: '350 / 1,000 words', pct: 35, done: false });
  assert.deepEqual(goalProgress(1020, 1000), { text: '✓ 1,020 / 1,000 words', pct: 100, done: true });
  assert.equal(goalProgress(0, 500).pct, 0);
});

test('sentences, speaking time and readability', async () => {
  const { countSentences, speakingTime, syllables, readability } = await import('./wordcount.js');
  assert.equal(countSentences('Hi there. How are you? Fine!\nNew line'), 4);
  assert.equal(countSentences('Version 2.5 is out. Get it.'), 2, 'a dot inside a number isn’t the end');
  assert.equal(countSentences(''), 0);
  assert.equal(speakingTime(130), '1 min');
  assert.equal(speakingTime(13000), '1 h 40 min');
  assert.deepEqual([syllables('cat'), syllables('table'), syllables('readability')], [1, 2, 5]);
  assert.equal(readability('Too short to say.'), null);
  const easy = 'The cat sat on the mat. It was a big cat. The dog ran to the cat. The cat ran up a tree. The dog sat down. It was a nice day. ';
  assert.equal(readability(easy).label, 'Very easy');
  const hard = 'Notwithstanding considerable organisational complexities, implementation methodologies necessitate comprehensive interdepartmental coordination, systematic documentation, and continuous evaluation of institutional performance indicators throughout successive operational periods, particularly regarding infrastructural modernisation initiatives and administrative harmonisation procedures across numerous international subsidiaries.';
  const r = readability(hard);
  assert.ok(r.score < 30 && r.label === 'Very difficult', JSON.stringify(r));
});
