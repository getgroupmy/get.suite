import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Bold from '@tiptap/extension-bold';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { SuggestInsert, SuggestDelete, suggestText, suggestDeleteKey, listSuggestions, resolveSuggestion, describeSuggestion, isSuggestion, onlySuggestionsAllowed } from './suggest.js';

const schema = getSchema([Document, Paragraph, Text, Bold, SuggestInsert, SuggestDelete]);
const ann = { id: 'u1', name: 'Ann' };
const bob = { id: 'u2', name: 'Bob' };
const doc = (...paras) => schema.node('doc', null, paras.map((t) => schema.node('paragraph', null, t ? [schema.text(t)] : [])));
const at = (state, pos) => state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
const make = (...paras) => EditorState.create({ schema, doc: doc(...paras) });
const run = (state, tr) => state.apply(tr);
// The text as it would be with every suggestion accepted / rejected.
const accepted = (s) => run(s, resolveSuggestion(s, null, true) || s.tr).doc.textContent;
const rejected = (s) => run(s, resolveSuggestion(s, null, false) || s.tr).doc.textContent;

test('typing becomes one suggestion per run of typing', () => {
  let s = make('Hello world');
  s = run(s, suggestText(s, 7, 7, 'big ', ann));
  s = run(s, suggestText(s, s.selection.from, s.selection.from, 'red ', ann));
  assert.equal(s.doc.textContent, 'Hello big red world');
  const list = listSuggestions(s.doc);
  assert.equal(list.length, 1, 'carries on the same suggestion');
  assert.equal(list[0].inserted, 'big red ');
  assert.equal(list[0].name, 'Ann');
  assert.equal(describeSuggestion(list[0]), 'Add “big red ”');
  assert.equal(accepted(s), 'Hello big red world');
  assert.equal(rejected(s), 'Hello world');
});

test('typing over a selection suggests a replacement', () => {
  let s = make('The cat sat');
  s = run(s, suggestText(s, 5, 8, 'dog', ann)); // "cat"
  assert.equal(s.doc.textContent, 'The catdog sat', 'the old word stays, struck through');
  const [one] = listSuggestions(s.doc);
  assert.equal(describeSuggestion(one), 'Replace “cat” with “dog”');
  assert.equal(accepted(s), 'The dog sat');
  assert.equal(rejected(s), 'The cat sat');
});

test('backspace and delete strike through, skipping what is already struck', () => {
  let s = at(make('abcdef'), 4); // after "c"
  s = run(s, suggestDeleteKey(s, -1, ann));
  s = run(s, suggestDeleteKey(s, -1, ann));
  assert.equal(s.selection.from, 2);
  assert.equal(s.doc.textContent, 'abcdef', 'nothing removed yet');
  let list = listSuggestions(s.doc);
  assert.equal(list.length, 1);
  assert.equal(list[0].deleted, 'bc');
  s = at(s, 4);
  s = run(s, suggestDeleteKey(s, -1, ann)); // hops over "bc" to "a"
  assert.equal(listSuggestions(s.doc)[0].deleted, 'abc');
  s = at(s, 4);
  s = run(s, suggestDeleteKey(s, 1, bob)); // forward delete of "d" by someone else
  list = listSuggestions(s.doc);
  assert.equal(list.length, 2);
  assert.equal(list[1].name, 'Bob');
  assert.equal(accepted(s), 'ef');
});

test('at the start of a paragraph backspace is left to join paragraphs', () => {
  const s = at(make('one', 'two'), 6);
  assert.equal(suggestDeleteKey(s, -1, ann), null);
});

test('deleting your own suggested text removes it outright', () => {
  let s = make('Hi');
  s = run(s, suggestText(s, 3, 3, ' there', ann));
  s = run(s, suggestDeleteKey(s, -1, ann));
  assert.equal(s.doc.textContent, 'Hi ther');
  assert.equal(listSuggestions(s.doc)[0].inserted, ' ther');
});

test('accepting or rejecting one leaves the others', () => {
  let s = make('one two three');
  s = run(s, suggestText(s, 5, 5, 'and ', ann));
  s = at(s, s.doc.content.size - 1);
  s = run(s, suggestDeleteKey(s, -1, bob));
  const [first, second] = listSuggestions(s.doc);
  s = run(s, resolveSuggestion(s, first.id, true));
  assert.equal(s.doc.textContent, 'one and two three');
  assert.equal(listSuggestions(s.doc).length, 1);
  s = run(s, resolveSuggestion(s, second.id, false));
  assert.equal(listSuggestions(s.doc).length, 0);
  assert.equal(s.doc.textContent, 'one and two three');
});

test('inserted text keeps the formatting where it is typed', () => {
  const bold = schema.marks.bold.create();
  let s = EditorState.create({ schema, doc: schema.node('doc', null, [schema.node('paragraph', null, [schema.text('Bold', [bold])])]) });
  s = run(s, suggestText(s, 3, 3, 'X', ann));
  let marks;
  s.doc.descendants((n) => { if (n.isText && n.text === 'X') marks = n.marks.map((m) => m.type.name).sort(); });
  assert.deepEqual(marks, ['bold', 'suggestInsert']);
});

test('a run of typing is one piece of text, not a mark per letter', () => {
  let s = make('ab');
  s = run(s, suggestText(s, 2, 2, 'x', ann, 1000));
  s = run(s, suggestText(s, 3, 3, 'y', ann, 2000));
  let pieces = 0;
  s.doc.descendants((n) => { if (n.isText && n.marks.length) pieces++; });
  assert.equal(pieces, 1);
  assert.equal(listSuggestions(s.doc)[0].at, 1000, 'dated from when it started');
});

test('suggest-only (commenters): suggestions go through; other changes are held back; selection moves are fine', () => {
  const s = make('Hello world');
  assert.equal(onlySuggestionsAllowed(isSuggestion(suggestText(s, 6, 6, 'big ', ann))), true);
  assert.equal(onlySuggestionsAllowed(s.tr.insertText('x', 1)), false, 'typed outright');
  assert.equal(onlySuggestionsAllowed(s.tr.addMark(1, 3, schema.marks.bold.create())), false, 'formatting');
  assert.equal(onlySuggestionsAllowed(s.tr.split(3)), false, 'a new paragraph');
  assert.equal(onlySuggestionsAllowed(s.tr.setSelection(TextSelection.create(s.doc, 3))), true);
});
