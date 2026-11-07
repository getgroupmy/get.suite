import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Footnote, footnotesOf, footnotesOfJson, htmlWithFootnotes } from './footnote.js';

const schema = getSchema([StarterKit, Footnote]);
const json = { type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'Sales grew' }, { type: 'footnote', attrs: { note: 'Source: Q3 report' } }, { type: 'text', text: ' fast.' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Costs <fell>' }, { type: 'footnote', attrs: { note: 'After "one-offs" & tax' } }] },
] };
const doc = schema.nodeFromJSON(json);

test('footnotes in order, with where they are', () => {
  const list = footnotesOf(doc);
  assert.deepEqual(list.map((f) => [f.n, f.note]), [[1, 'Source: Q3 report'], [2, 'After "one-offs" & tax']]);
  assert.equal(doc.nodeAt(list[0].pos).type.name, 'footnote');
  assert.deepEqual(footnotesOfJson(json), ['Source: Q3 report', 'After "one-offs" & tax']);
});

test('HTML: numbered markers linking to the notes at the end (escaped)', () => {
  // As the editor writes it (getHTML).
  const html = '<p>Sales grew<sup data-note="Source: Q3 report" data-footnote="" class="footnote-ref" title="Source: Q3 report"></sup> fast.</p>'
    + '<p>Costs &lt;fell&gt;<sup data-note="After &quot;one-offs&quot; &amp; tax" data-footnote="" class="footnote-ref" title="x"></sup></p>';
  const out = htmlWithFootnotes(html);
  assert.match(out, /Sales grew<sup class="footnote-ref" id="fnref-1"><a href="#fn-1">1<\/a><\/sup> fast\./);
  assert.match(out, /<li id="fn-2">After &quot;one-offs&quot; &amp; tax <a href="#fnref-2"/);
  assert.ok(!out.includes('<fell>'));
  // Reading the HTML back keeps the note.
  const plain = '<p>x<sup data-footnote="" data-note="Hi &amp; bye"></sup></p>';
  assert.equal(htmlWithFootnotes('<p>none</p>'), '<p>none</p>');
  assert.match(htmlWithFootnotes(plain), /<li id="fn-1">Hi &amp; bye/);
});
