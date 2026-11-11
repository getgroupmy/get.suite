import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notePrintHtml } from './noteprint.js';

test('printing a note: title, checklist with ticks and sub-items, labels; nothing unescaped', () => {
  const html = notePrintHtml({ title: 'Packing <list>', items: [{ text: 'Passport', done: true }, { text: 'Phone', indent: 1 }], labels: ['Trip'] });
  assert.match(html, /<h1>Packing &lt;list&gt;<\/h1>/);
  assert.match(html, /<li class="done"><span>☑<\/span> Passport<\/li>/);
  assert.match(html, /<li class=" sub"><span>☐<\/span> Phone<\/li>/);
  assert.match(html, /class="labels">Trip</);
  assert.match(notePrintHtml({ title: '', body: 'a\nb' }), /<p>a<br>b<\/p>/);
});
