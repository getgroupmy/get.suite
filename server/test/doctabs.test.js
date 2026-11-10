import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docText } from '../src/search.js';
import { flattenTabs, tabsOf, isTabbed } from '../src/office/doctabs.js';
import { countText } from '../src/wordcount.js';

const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = { type: 'doc', content: [
  { type: 'docTab', attrs: { id: 'a', title: 'Plan' }, content: [p('Open two shops')] },
  { type: 'docTab', attrs: { id: 'b', title: 'Budget' }, content: [p('Rent comes to four thousand')] },
] };

test('documents with tabs: search and word count see every tab', () => {
  assert.match(docText(doc), /Open two shops/);
  assert.match(docText(doc), /four thousand/, 'text in the second tab is found');
  assert.equal(countText(docText(doc)).words, 8, 'Drive\'s Details count every tab');
});

test('documents with tabs: the server copy of the helpers', () => {
  assert.equal(isTabbed(doc), true);
  assert.deepEqual(tabsOf(doc).map((t) => t.title), ['Plan', 'Budget']);
  assert.deepEqual(flattenTabs(doc).content.map((n) => n.type), ['heading', 'paragraph', 'pageBreak', 'heading', 'paragraph']);
});
