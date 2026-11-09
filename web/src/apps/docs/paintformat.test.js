import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { captureFormat, applyFormat, wordAt } from './paintformat.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', attrs: { textAlign: { default: null }, lineHeight: { default: null } } },
    heading: { group: 'block', content: 'text*', attrs: { level: { default: 1 }, textAlign: { default: null }, lineHeight: { default: null } } },
    text: {},
  },
  marks: { bold: {}, italic: {}, link: { attrs: { href: {} } }, textStyle: { attrs: { color: { default: null }, fontSize: { default: null } } } },
});
const { bold, italic, link, textStyle } = schema.marks;
const doc = schema.node('doc', null, [
  schema.node('heading', { level: 2, textAlign: 'center' }, [schema.text('Big ', [bold.create(), textStyle.create({ color: '#ff0000', fontSize: '18pt' })]), schema.text('title')]),
  schema.node('paragraph', null, [schema.text('plain '), schema.text('linked', [link.create({ href: 'https://x' }), italic.create()]), schema.text(' words here')]),
]);
const at = (from, to = from) => EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });

test('copies the marks and the paragraph style where the selection starts', () => {
  const f = captureFormat(at(1, 3));
  assert.deepEqual(f.marks.map((m) => m.type).sort(), ['bold', 'textStyle']);
  assert.equal(f.marks.find((m) => m.type === 'textStyle').attrs.color, '#ff0000');
  assert.deepEqual(f.block, { type: 'heading', attrs: { level: 2, textAlign: 'center', lineHeight: null } });
  const g = captureFormat(at(doc.child(0).nodeSize + 8, doc.child(0).nodeSize + 9)); // inside "linked": the link isn't formatting
  assert.deepEqual(g.marks.map((m) => m.type), ['italic']);
});

test('applying replaces the formatting there, keeps links, and restyles the paragraph', () => {
  const fmt = captureFormat(at(1, 3));
  const p = doc.child(0).nodeSize; // the paragraph starts after the heading
  const from = p + 1 + 6, to = p + 1 + 12; // "linked"
  const next = at(1).apply(applyFormat(at(1), fmt, from, to)).doc;
  const para = next.child(1);
  assert.equal(para.type.name, 'heading');
  assert.equal(para.attrs.level, 2);
  assert.equal(para.attrs.textAlign, 'center');
  const linked = para.child(1);
  assert.equal(linked.text, 'linked');
  assert.deepEqual(linked.marks.map((m) => m.type.name).sort(), ['bold', 'link', 'textStyle']);
  assert.equal(para.child(0).marks.length, 0, 'the rest of the line is untouched');
});

test('plain text paints plain: formatting goes, headings become normal text', () => {
  const p = doc.child(0).nodeSize;
  const fmt = captureFormat(at(p + 2)); // inside "plain"
  assert.deepEqual(fmt.marks, []);
  const next = at(1).apply(applyFormat(at(1), fmt, 1, 4)).doc;
  assert.equal(next.child(0).type.name, 'paragraph');
  assert.equal(next.child(0).child(0).text, 'Big');
  assert.equal(next.child(0).child(0).marks.length, 0);
});

test('a click without a selection takes the word', () => {
  const p = doc.child(0).nodeSize;
  const w = wordAt(doc, p + 1 + 15); // inside "words"
  assert.equal(doc.textBetween(w.from, w.to), 'words');
  const between = wordAt(schema.node('doc', null, [schema.node('paragraph', null, [schema.text('a  b')])]), 3);
  assert.equal(between, null, 'between two spaces: no word');
});
