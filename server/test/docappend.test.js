import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docFromJson, jsonFromDoc, appendToYDoc, appendToJson } from '../src/collabdoc.js';
import { docFromText } from '../src/doctext.js';

const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const plain = { type: 'doc', content: [p('First')] };
const tabbed = { type: 'doc', content: [
  { type: 'docTab', attrs: { id: 't1', title: 'Monday' }, content: [p('Mon notes')] },
  { type: 'docTab', attrs: { id: 't2', title: '' }, content: [p('Second tab')] },
] };
const added = docFromText('## Minutes\nAgreed the budget').content;

test('stored: to the end of the document, or of a tab (named, else the last)', () => {
  const a = appendToJson(plain, added);
  assert.equal(a.tab, null);
  assert.deepEqual(a.json.content.map((n) => n.type), ['paragraph', 'heading', 'paragraph']);
  const b = appendToJson(tabbed, added, 'monday');
  assert.equal(b.tab, 'Monday');
  assert.equal(b.json.content[0].content.length, 3);
  assert.equal(b.json.content.length, 2, 'still all tabs');
  const c = appendToJson(tabbed, added);
  assert.equal(c.tab, 'Tab 2', 'the last tab, by its shown name');
  assert.throws(() => appendToJson(tabbed, added, 'Friday'), /No tab called “Friday”: it has “Monday”, “Tab 2”/);
});

test('live (Yjs): the same, and it reads back as the same JSON', () => {
  const d = docFromJson(plain);
  assert.equal(appendToYDoc(d, added), null);
  assert.deepEqual(jsonFromDoc(d), appendToJson(plain, added).json);
  const t = docFromJson(tabbed);
  assert.equal(appendToYDoc(t, added, 'Monday'), 'Monday');
  assert.deepEqual(jsonFromDoc(t), appendToJson(tabbed, added, 'Monday').json);
});
