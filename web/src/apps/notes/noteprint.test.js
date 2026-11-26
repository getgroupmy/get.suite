import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notesPrintHtml, notePrintHtml, noteEmail, notesEmail, noteEvent, noteEventAt, withComments } from './noteprint.js';

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

test('a note as a calendar event: its title, and its text or checklist with a link back as the description', () => {
  assert.deepEqual(noteEvent({ title: 'Trip', items: [{ text: 'Book hotel' }, { text: 'Passport', done: true }, { text: 'Photo', indent: 1 }] }, 'https://ws.test/notes?note=1'),
    { title: 'Trip', description: '☐ Book hotel\n☑ Passport\n  ☐ Photo\n\nFrom my notes: https://ws.test/notes?note=1' });
  assert.deepEqual(noteEvent({ body: 'Call the bank\nabout the card' }), { title: 'Call the bank', description: 'Call the bank\nabout the card' });
  assert.deepEqual(noteEvent({}), { title: 'Note', description: '' });
});

test('scheduling time for a note: the next full hour, or the day and time its title names', () => {
  const now = new Date(2026, 10, 23, 9, 10).getTime(); // a Monday
  const at = (e) => [e.title, new Date(e.start).getDate(), new Date(e.start).getHours(), (e.end - e.start) / 6e4, e.all_day];
  assert.deepEqual(at(noteEventAt({ title: 'Trip', body: 'Pack' }, '', now)), ['Trip', 23, 10, 60, 0]);
  assert.deepEqual(at(noteEventAt({ title: 'Dentist friday 9am', body: 'Bring the form' }, '', now)), ['Dentist', 27, 9, 60, 0]);
  assert.equal(noteEventAt({ title: 'Dentist friday 9am', body: 'Bring the form' }, 'https://ws.test/notes?note=1', now).description, 'Bring the form\n\nFrom my notes: https://ws.test/notes?note=1');
});

test('printing a shared note: its comments under it (escaped), fetched only for notes that have some', async () => {
  const html = notePrintHtml({ title: 'Offsite', body: 'Where?', commentList: [{ text: 'Lake <house>\nfree', at: Date.UTC(2026, 10, 26, 9), by: { name: 'Kim & Co' } }, { text: 'ok', at: 1, edited_at: 2 }] });
  assert.match(html, /Where\?<\/p><section class="comments"><h2>Comments<\/h2><ul><li><b>Kim &amp; Co<\/b> <span class="when">[^<]+<\/span><br>Lake &lt;house&gt;<br>free<\/li><li><b>Someone<\/b> <span class="when">[^<]+ \(edited\)<\/span><br>ok<\/li>/);
  assert.doesNotMatch(html.split('Someone')[0], /edited/, 'only the one changed');
  assert.doesNotMatch(notePrintHtml({ title: 'Plain', body: 'x' }), /class="comments"/);
  // A comment's reactions under it, with who.
  const reacted = notePrintHtml({ title: 'R', body: 'x', commentList: [{ text: 'Yes', at: 1, by: { name: 'Ann' }, reactions: [{ emoji: '👍', users: [{ name: 'Bo & Cy' }, { name: 'Di' }] }, { emoji: '🎉', users: [{ name: 'Ann' }] }] }] });
  assert.match(reacted, /<br>Yes<br><span class="reactions">👍 Bo &amp; Cy, Di · 🎉 Ann<\/span><\/li>/);
  const asked = [];
  const got = await withComments([{ id: 'a', comments: 2 }, { id: 'b', comments: 0 }, { id: 'c', comments: 1 }], async (u) => { asked.push(u); if (u.includes('/c/')) throw new Error('gone'); return [{ text: 'hi' }]; });
  assert.deepEqual(asked, ['/notes/a/comments', '/notes/c/comments']);
  assert.deepEqual(got.map((n) => n.commentList), [[{ text: 'hi' }], undefined, []]);
  assert.match(notesPrintHtml(got), /<section class="note">.*class="comments".*<\/section><section class="note">/s);
});
