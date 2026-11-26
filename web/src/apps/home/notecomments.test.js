import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newNoteComments } from './notecomments.js';

test('New note comments: notes with new ones, the most new first, then as listed; how many more', () => {
  const notes = [{ id: 'a', comments_new: 1 }, { id: 'b', comments_new: 0, comments: 3 }, { id: 'c', comments_new: 4 }, { id: 'd' }, { id: 'e', comments_new: 1 }];
  assert.deepEqual(newNoteComments(notes), { items: [notes[2], notes[0], notes[4]], more: 0 });
  assert.deepEqual(newNoteComments(notes, 2), { items: [notes[2], notes[0]], more: 1 });
  assert.deepEqual(newNoteComments(undefined), { items: [], more: 0 });
});
