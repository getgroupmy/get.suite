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

test('regular expressions: patterns, groups in replacements, bad patterns', async () => {
  const { findPattern, replacementFor } = await import('./findReplace.js');
  const d = doc(['Invoices INV-2041 and inv-17, paid 2026-11-09.'], ['Call +60 12 345']);
  assert.deepEqual(texts(d, findMatches(d, 'INV-\\d+', { regex: true })), ['INV-2041', 'inv-17'], 'any case by default');
  assert.deepEqual(texts(d, findMatches(d, 'INV-\\d+', { regex: true, matchCase: true })), ['INV-2041']);
  assert.deepEqual(texts(d, findMatches(d, 'paid|call', { regex: true, wholeWord: true })), ['paid', 'Call'], 'alternatives stay whole words');
  const [date] = findMatches(d, '(\\d{4})-(\\d{2})-(\\d{2})', { regex: true });
  assert.equal(replacementFor('$3/$2/$1 ($&, $$5)', date, true), '09/11/2026 (2026-11-09, $5)');
  assert.equal(replacementFor('$1', date, false), '$1', 'plain text: as typed');
  assert.equal(findPattern('(unclosed', { regex: true }).error, 'That isn’t a valid regular expression');
  assert.deepEqual(findMatches(d, '(unclosed', { regex: true }), []);
  assert.deepEqual(texts(d, findMatches(d, 'a.d', {})), [], 'without the option, . is a dot');
  assert.deepEqual(findMatches(d, '\\b', { regex: true }), [], 'empty matches are left out');
});
