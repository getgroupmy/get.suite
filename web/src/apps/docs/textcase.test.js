import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { changeCase, caseTransaction } from './textcase.js';
import { curly, substitute, BUILT_IN } from './autocorrect.js';

test('changing case', () => {
  assert.equal(changeCase('Hello World', 'lower'), 'hello world');
  assert.equal(changeCase('straße', 'upper'), 'STRAßE', 'ß keeps its place (it would become two letters)');
  assert.equal(changeCase('the lord of the rings: the return of the king', 'title'), 'The Lord of the Rings: The Return of the King');
  assert.equal(changeCase('a trip to the UK with NASA', 'title'), 'A Trip to the UK With NASA'.replace('With', 'with'));
  assert.equal(changeCase("it's DONE. then i went home! ok", 'sentence'), "It's done. Then I went home! Ok");
  assert.equal(changeCase('more words', 'sentence', { start: false }), 'more words');
});

test('the case of a selection, keeping bold and italic', () => {
  const schema = getSchema([StarterKit]);
  const doc = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'make ' }, { type: 'text', text: 'this bold', marks: [{ type: 'bold' }] }, { type: 'text', text: ' louder' }] }] });
  let state = EditorState.create({ doc });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)));
  const after = state.apply(caseTransaction(state, 'upper'));
  assert.equal(after.doc.textContent, 'MAKE THIS BOLD LOUDER');
  const bold = []; after.doc.descendants((n) => { if (n.isText && n.marks.length) bold.push(n.text); });
  assert.deepEqual(bold, ['THIS BOLD']);
  assert.equal(after.selection.to - after.selection.from, 'MAKE THIS BOLD LOUDER'.length, 'still selected');
});

test('autocorrect: quotes, replacements', () => {
  assert.equal(curly('"', ''), '“');
  assert.equal(curly('"', 'word'), '”');
  assert.equal(curly("'", 'don'), '’');
  assert.equal(curly("'", ' '), '‘');
  assert.equal(substitute('addr', [{ from: 'addr', to: '12 High St' }]), '12 High St');
  assert.equal(substitute('other', [{ from: 'addr', to: 'x' }]), null);
  assert.ok(BUILT_IN.some(([a, b]) => a === '--' && b === '—'));
});
