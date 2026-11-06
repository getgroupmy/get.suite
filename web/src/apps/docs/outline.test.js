import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { headingsOf, currentHeading } from './outline.js';

const schema = getSchema([StarterKit]);
const doc = schema.nodeFromJSON({ type: 'doc', content: [
  { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Plan' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Budget ' }] },
  { type: 'heading', attrs: { level: 2 } },
  { type: 'blockquote', content: [{ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Quoted' }] }] },
] });

test('outline: headings in order, empty ones left out, nested ones found', () => {
  const h = headingsOf(doc);
  assert.deepEqual(h.map((x) => [x.level, x.text]), [[1, 'Plan'], [2, 'Budget'], [3, 'Quoted']]);
  assert.equal(doc.nodeAt(h[1].pos).textContent, 'Budget ');
});

test('outline: the heading the cursor is under', () => {
  const h = headingsOf(doc);
  assert.equal(currentHeading(h, 0), 0);
  assert.equal(currentHeading(h, h[1].pos + 2), 1);
  assert.equal(currentHeading(h, doc.content.size), 2);
  assert.equal(currentHeading([], 5), -1);
});
