import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Superscript, Subscript } from './scripts.js';

test('superscript and subscript marks: in the schema, never both at once', () => {
  const schema = getSchema([StarterKit, Superscript, Subscript]);
  assert.ok(schema.marks.superscript && schema.marks.subscript);
  const sup = schema.marks.superscript.create(), sub = schema.marks.subscript.create();
  assert.ok(!sup.isInSet(sub.addToSet([])));
  const both = sup.addToSet(sub.addToSet([]));
  assert.deepEqual(both.map((m) => m.type.name), ['superscript'], 'adding one takes the other off');
});
