import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { splitSentences, sentencesFrom } from './readaloud.js';

const schema = getSchema([StarterKit]);
const pieces = (t) => splitSentences(t).map((s) => t.slice(s.start, s.end));

test('sentences: at . ! ? … with closing quotes, not after abbreviations or initials', () => {
  assert.deepEqual(pieces('Hello there. How are you? Fine!  Thanks…'), ['Hello there.', 'How are you?', 'Fine!', 'Thanks…']);
  assert.deepEqual(pieces('Dr. Lee met J. Smith at 3.30 today. She said “Go.” Then left.'), ['Dr. Lee met J. Smith at 3.30 today.', 'She said “Go.”', 'Then left.']);
  assert.deepEqual(pieces('Bring pens, paper, etc. and a laptop. Done'), ['Bring pens, paper, etc. and a laptop.', 'Done']);
  assert.deepEqual(pieces('   '), []);
  assert.deepEqual(pieces('No full stop at the end'), ['No full stop at the end']);
});

test('sentencesFrom: block by block, with document positions, from the cursor on', () => {
  const d = schema.nodeFromJSON({ type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Plan' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'First one. ' }, { type: 'text', text: 'Second', marks: [{ type: 'bold' }] }, { type: 'text', text: ' one.' }] },
    { type: 'paragraph' },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'An item' }, { type: 'hardBreak' }, { type: 'text', text: 'on two lines' }] }] }] },
  ] });
  const all = sentencesFrom(d, 0);
  assert.deepEqual(all.map((s) => s.text), ['Plan', 'First one.', 'Second one.', 'An item on two lines']);
  for (const s of all.slice(0, 3)) assert.equal(d.textBetween(s.from, s.to), s.text, 'positions point at the sentence');
  // From the middle of "First one.": the rest of it, then on.
  const mid = all[1].from + 6;
  assert.deepEqual(sentencesFrom(d, mid).map((s) => s.text), ['one.', 'Second one.', 'An item on two lines']);
  // From the end: nothing.
  assert.deepEqual(sentencesFrom(d, d.content.size), []);
});
