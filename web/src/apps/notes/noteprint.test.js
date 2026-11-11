import test from 'node:test';
import assert from 'node:assert/strict';
import { noteEmail } from './noteprint.js';

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
