import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notesPrintHtml, notePrintHtml, noteEmail, notesEmail } from './noteprint.js';

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

test('a printed note shows its pictures, from this server', () => {
  const html = notePrintHtml({ id: 'n 1', title: 'Trip', body: 'Beach', pictures: ['p1', { id: 'p2' }] });
  assert.match(html, /<img src="\/api\/notes\/n%201\/pictures\/p1" alt="">/);
  assert.match(html, /\/pictures\/p2"/);
  assert.doesNotMatch(notePrintHtml({ title: 'No pics', body: 'x' }), /<img/);
});

test('several notes as one email: each under its title, with its link; the subject says how many', () => {
  const e = notesEmail([{ id: 'a', title: 'Groceries', items: [{ text: 'Milk', done: false }] }, { id: 'b', title: 'Trip <plan>', body: 'Beach' }], (n) => `https://ws/notes?open=${n.id}`);
  assert.equal(e.subject, '2 notes');
  assert.match(e.html, /<p><strong>Groceries<\/strong><\/p>[\s\S]*☐ Milk[\s\S]*<p><strong>Trip &lt;plan&gt;<\/strong><\/p><p>Beach<\/p>/);
  assert.match(e.html, /notes\?open=a[\s\S]*notes\?open=b/);
  assert.equal(notesEmail([{ title: 'Same', body: 'x' }, { title: 'Same', body: 'y' }]).subject, 'Same');
  assert.equal(notesEmail([{ title: 'One', body: 'x' }]).subject, 'One');
});
