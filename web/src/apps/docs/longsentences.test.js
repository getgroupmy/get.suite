import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { longSentences, repeatedWords } from './longsentences.js';

const schema = getSchema([StarterKit]);
const words = (n, w = 'word') => Array.from({ length: n }, () => w).join(' ');

test('sentences of 25 words or more, and 35 or more as very long, with where they are', () => {
  const d = schema.nodeFromJSON({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: `Short one here. ${words(26)}. Fine again.` }] },
    { type: 'paragraph', content: [{ type: 'text', text: `${words(40, 'longer')}!` }] },
    { type: 'paragraph', content: [{ type: 'text', text: words(24) }] },
  ] });
  const list = longSentences(d);
  assert.deepEqual(list.map((s) => [s.words, s.very]), [[26, false], [40, true]]);
  assert.equal(d.textBetween(list[0].from, list[0].to), `${words(26)}.`);
  assert.equal(longSentences(d, 41).length, 0);
});

test('words twice in a row: any case, across formatting; not "had had", numbers or different words', () => {
  const d = schema.nodeFromJSON({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Send the ' }, { type: 'text', text: 'the', marks: [{ type: 'bold' }] }, { type: 'text', text: ' report. The The end. He had had enough. 10 10 times. theme the' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'and' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'and again' }] },
  ] });
  const r = repeatedWords(d);
  assert.deepEqual(r.map((x) => x.word), ['the', 'The']);
  assert.equal(d.textBetween(r[0].from, r[0].to), 'the');
});
