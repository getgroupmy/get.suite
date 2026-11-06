import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { findMatches, countWords } from './findReplace.js';

const schema = getSchema([StarterKit]);
const doc = (...paras) => schema.nodeFromJSON({ type: 'doc', content: paras.map((p) => ({ type: 'paragraph', content: p.map((t) => (typeof t === 'string' ? { type: 'text', text: t } : t)) })) });
const texts = (d, ms) => ms.map((m) => d.textBetween(m.from, m.to));

test('finding: any case by default, across formatting, block by block', () => {
  const d = doc(['The cat sat. ', { type: 'text', text: 'Cat', marks: [{ type: 'bold' }] }, 'alogue'], ['concatenate CAT']);
  assert.deepEqual(texts(d, findMatches(d, 'cat')), ['cat', 'Cat', 'cat', 'CAT']);
  assert.deepEqual(texts(d, findMatches(d, 'cat', { matchCase: true })), ['cat', 'cat']);
  assert.deepEqual(texts(d, findMatches(d, 'cat', { wholeWord: true })), ['cat', 'CAT']);
  assert.deepEqual(texts(d, findMatches(d, 'Catalogue')), ['Catalogue'], 'a match can span bold and plain text');
  assert.deepEqual(findMatches(d, 'sat. Cat').length, 1);
  assert.deepEqual(findMatches(d, 'logueconcat'), [], 'not across paragraphs');
  assert.deepEqual(findMatches(d, ''), []);
  assert.deepEqual(texts(d, findMatches(d, 'a.')), [], 'the text is literal, not a pattern');
});

test('a line break is never part of a match', () => {
  const d = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ab' }, { type: 'hardBreak' }, { type: 'text', text: 'cd ab' }] }] });
  assert.deepEqual(texts(d, findMatches(d, 'ab')), ['ab', 'ab']);
  assert.deepEqual(findMatches(d, 'bc'), []);
});

test('word count', () => {
  assert.deepEqual(countWords(doc(['Hello, world — it’s 2026.'], ['Second line'])), { words: 6, characters: 31 });
  assert.deepEqual(countWords(doc([])), { words: 0, characters: 0 });
});
