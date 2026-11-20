import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freeTabTitle, tabContentCopy, withTabAdded, tabOf } from '../src/doctabcopy.js';
import { docFromJson, jsonFromDoc, setYDocJson } from '../src/collabdoc.js';

const p = (text, marks) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(marks && { marks }) }] });

test('a copied tab keeps its title when it\'s free there, else "Copy of …"', () => {
  assert.equal(freeTabTitle('Plan', ['Notes']), 'Plan');
  assert.equal(freeTabTitle('Plan', ['plan']), 'Copy of Plan');
  assert.equal(freeTabTitle('Plan', ['Plan', 'Copy of Plan']), 'Copy of Plan 2');
  assert.equal(freeTabTitle('x'.repeat(80), []).length, 60);
});

test('the copy: text as it stands, no comment highlights, pictures pointing at their copies (others left out)', () => {
  const tab = { type: 'docTab', attrs: { id: 't1', title: 'Plan' }, content: [
    p('Kept', [{ type: 'bold' }, { type: 'comment', attrs: { id: 'c1' } }]),
    { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'new ', marks: [{ type: 'suggestInsert', attrs: { id: 's' } }] }, { type: 'text', text: 'old', marks: [{ type: 'suggestDelete', attrs: { id: 's' } }] }] },
    { type: 'image', attrs: { fileId: 'a', alt: 'A' } }, { type: 'image', attrs: { fileId: 'b' } },
  ] };
  assert.deepEqual(tabContentCopy(tab, new Map([['a', 'A2']])), [
    p('Kept', [{ type: 'bold' }]), p('Hello old'), { type: 'image', attrs: { fileId: 'A2', alt: 'A' } },
  ]);
  assert.deepEqual(tabContentCopy({ type: 'docTab', content: [{ type: 'image', attrs: { fileId: 'z' } }] }), [{ type: 'paragraph' }], 'never empty');
  assert.equal(tab.content[0].content[0].marks.length, 2, 'the original untouched');
});

test('adding the tab: at the end with a free title; a document without tabs first becomes "Tab 1"; 50 at most', () => {
  let n = 0;
  const id = () => `n${++n}`;
  const copy = { type: 'docTab', attrs: { title: 'Plan' }, content: [p('x')] };
  const plain = withTabAdded({ type: 'doc', content: [p('Intro')] }, copy, id);
  assert.deepEqual(plain.json.content, [{ type: 'docTab', attrs: { id: 'n1', title: 'Tab 1' }, content: [p('Intro')] }, { type: 'docTab', attrs: { id: 'n2', title: 'Plan' }, content: [p('x')] }]);
  assert.equal(plain.at, 2);
  const again = withTabAdded(plain.json, copy, id);
  assert.equal(again.title, 'Copy of Plan');
  assert.equal(tabOf(again.json, 'n3').attrs.title, 'Copy of Plan');
  const full = { type: 'doc', content: Array.from({ length: 50 }, (_, i) => ({ type: 'docTab', attrs: { id: `t${i}`, title: `T${i}` }, content: [p('.')] })) };
  assert.equal(withTabAdded(full, copy, id), null);
});

test('setting a live document\'s JSON keeps the blocks at its start that are the same', () => {
  const doc = docFromJson({ type: 'doc', content: [p('One'), p('Two')] });
  const first = doc.getXmlFragment('default').get(0);
  setYDocJson(doc, { type: 'doc', content: [p('One'), p('Three', [{ type: 'italic' }]), p('Four')] });
  assert.deepEqual(jsonFromDoc(doc).content, [p('One'), p('Three', [{ type: 'italic' }]), p('Four')]);
  assert.equal(doc.getXmlFragment('default').get(0), first, 'the same block, not a replacement');
  setYDocJson(doc, { type: 'doc', content: [] });
  assert.deepEqual(jsonFromDoc(doc).content, []);
});
