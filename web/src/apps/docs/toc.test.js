import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableOfContents, contentsOf, htmlWithContents } from './toc.js';

const schema = getSchema([StarterKit, TableOfContents]);
const doc = schema.nodeFromJSON({ type: 'doc', content: [
  { type: 'tableOfContents' },
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan & goals' }] },
  { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Budget' }] },
  { type: 'heading', attrs: { level: 3 } },
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan & goals' }] },
] });

test('contents: headings with text, levels counted from the top one', () => {
  assert.deepEqual(contentsOf(doc).map((e) => [e.level, e.text]), [[1, 'Plan & goals'], [2, 'Budget'], [1, 'Plan & goals']]);
  assert.deepEqual(contentsOf(schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph' }] })), []);
});

test('the contents block survives JSON and HTML round trips', () => {
  assert.equal(doc.toJSON().content[0].type, 'tableOfContents');
  assert.equal(schema.nodes.tableOfContents.spec.parseDOM[0].tag, 'nav[data-toc]');
});

test('exported HTML gets a filled-in list linking to heading ids', () => {
  const html = '<nav data-toc="" class="doc-toc"></nav><h2>Plan &amp; goals</h2><h3>Budget</h3><h3></h3><h2>Plan &amp; goals</h2>';
  const out = htmlWithContents(html, doc);
  assert.match(out, /<h2 id="plan-goals">Plan &amp; goals<\/h2><h3 id="budget">Budget<\/h3><h3><\/h3><h2 id="plan-goals-2">/);
  assert.match(out, /<a href="#plan-goals">Plan &amp; goals<\/a>/);
  assert.match(out, /<li style="margin-left:1.5em"><a href="#budget">Budget<\/a>/);
  assert.match(out, /<a href="#plan-goals-2">/);
  assert.equal(htmlWithContents('<p>x</p>', doc), '<p>x</p>');
});
