import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { Indent, indentTransaction, cleanIndent } from './indent.js';

const schema = getSchema([StarterKit, Indent]);
const doc = schema.nodeFromJSON({ type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Two' }] },
  { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'In a list' }] }] }] },
] });

test('indenting the paragraphs and headings in the selection, not list items', () => {
  let state = EditorState.create({ doc });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 5)));
  state = state.apply(indentTransaction(state, 1));
  state = state.apply(indentTransaction(state, 1));
  const indents = []; state.doc.descendants((n) => { if (n.isTextblock) indents.push(n.attrs.indent); });
  assert.deepEqual(indents, [2, 2, 0]);
  state = state.apply(indentTransaction(state, -1));
  const back = []; state.doc.descendants((n) => { if (n.isTextblock) back.push(n.attrs.indent); });
  assert.deepEqual(back, [1, 1, 0]);
});

test('not past the edges', () => {
  const state = EditorState.create({ doc });
  assert.equal(indentTransaction(state, -1), null, 'already at the margin');
  assert.equal(cleanIndent(20), 8);
  assert.equal(cleanIndent(-3), 0);
  assert.equal(cleanIndent('2.4'), 2);
});
