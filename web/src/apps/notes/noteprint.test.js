import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notesPrintHtml, notePrintHtml, noteEmail } from './noteprint.js';

test('printing a note: title, checklist with ticks and sub-items, labels; nothing unescaped', () => {
  const html = notePrintHtml({ title: 'Packing <list>', items: [{ text: 'Passport', done: true }, { text: 'Phone', indent: 1 }], labels: ['Trip'] });
  assert.match(html, /<h1>Packing &lt;list&gt;<\/h1>/);
  assert.match(html, /<li class="done"><span>☑<\/span> Passport<\/li>/);
  assert.match(html, /<li class=" sub"><span>☐<\/span> Phone<\/li>/);
  assert.match(html, /class="labels">Trip</);
  assert.match(notePrintHtml({ title: '', body: 'a\nb' }), /<p>a<br>b<\/p>/);
});

test('noteEmail: the title as the subject, the text or checklist as the message', () => {
  assert.deepEqual(noteEmail({ title: 'Shopping', body: 'Milk\nBread & <jam>' }), { subject: 'Shopping', html: '<p>Milk<br>Bread &amp; &lt;jam&gt;</p>' });
  const c = noteEmail({ title: '', items: [{ text: 'Pack bags', done: true }, { text: 'Passport', indent: 1 }] }, 'https://ws.test/notes?note=n1');
  assert.equal(c.subject, 'Pack bags', 'no title: the first item');
  assert.match(c.html, /☑ <s>Pack bags<\/s>/);
  assert.match(c.html, /<li style="padding-left:24px">☐ Passport<\/li>/);
  assert.match(c.html, /From my notes: <a href="https:\/\/ws\.test\/notes\?note=n1">/);
  assert.equal(noteEmail({ body: 'x'.repeat(80) }).subject, `${'x'.repeat(57)}…`);
  assert.equal(noteEmail({}).subject, 'Note');
});

test('several notes print together, each on its own page', () => {
  const html = notesPrintHtml([{ title: 'One', body: 'First <b>' }, { title: 'Two', items: [{ text: 'Milk', done: true }] }]);
  assert.match(html, /<title>Notes \(2\)<\/title>/);
  assert.equal((html.match(/<section class="note">/g) || []).length, 2);
  assert.match(html, /First &lt;b&gt;/);
  assert.match(html, /section\.note \+ section\.note \{ break-before: page; \}/);
  assert.match(html, /☑<\/span> Milk/);
});
