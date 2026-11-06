import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { docFromJson, jsonFromDoc } from '../src/collabdoc.js';

const doc = { type: 'doc', content: [
  { type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [{ type: 'text', text: 'Plan' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
    { type: 'text', text: ' and a ' }, { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.com', target: '_blank' } }, { type: 'italic' }] }] },
  { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }] }] },
  { type: 'paragraph' },
] };

test('a stored document converts to the shared form and back unchanged', () => {
  const y = docFromJson(doc);
  assert.deepEqual(jsonFromDoc(y), doc);
});

test('edits merge: two copies changed at once end up the same', () => {
  const a = docFromJson(doc);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  // A types at the start of the heading while B adds a paragraph at the end.
  a.getXmlFragment('default').get(0).get(0).insert(0, 'Q4 ');
  b.getXmlFragment('default').insert(4, [new Y.XmlElement('paragraph')]);
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const ja = jsonFromDoc(a), jb = jsonFromDoc(b);
  assert.deepEqual(ja, jb);
  assert.equal(ja.content[0].content[0].text, 'Q4 Plan');
  assert.equal(ja.content.length, 5);
});
