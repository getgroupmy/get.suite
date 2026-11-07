import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocksOf, diffWords, diffDocs, changeCount } from './docdiff.js';

const p = (text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });
const h = (text) => ({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] });
const doc = (...content) => ({ type: 'doc', content });

test('blocks: headings, paragraphs and list items as text; empty paragraphs left out', () => {
  const d = doc(h('Plan'), p('One'), p(''), { type: 'bulletList', content: [{ type: 'listItem', content: [p('Item')] }] });
  assert.deepEqual(blocksOf(d).map((b) => [b.kind, b.text]), [['heading', 'Plan'], ['para', 'One'], ['item', 'Item']]);
});

test('words: what was added and taken out', () => {
  assert.deepEqual(diffWords('The cat sat', 'The black cat sat down'), [{ t: 'same', text: 'The ' }, { t: 'add', text: 'black ' }, { t: 'same', text: 'cat sat' }, { t: 'add', text: ' down' }]);
  assert.deepEqual(diffWords('a b', 'a b'), [{ t: 'same', text: 'a b' }]);
});

test('documents: same, edited, removed and added paragraphs', () => {
  const before = doc(h('Plan'), p('We meet on Monday.'), p('Budget is 10k.'), p('Old note'));
  const after = doc(h('Plan'), p('We meet on Tuesday.'), p('Budget is 10k.'), p('New idea'), p('Another'));
  const d = diffDocs(before, after);
  assert.deepEqual(d.map((b) => b.change), ['same', 'edit', 'same', 'edit', 'add']);
  assert.deepEqual(d[1].parts.filter((x) => x.t !== 'same').map((x) => [x.t, x.text]), [['del', 'Monday.'], ['add', 'Tuesday.']]);
  assert.deepEqual(changeCount(d), { added: 4, removed: 3 });
  assert.deepEqual(diffDocs(before, before).every((b) => b.change === 'same'), true);
});
