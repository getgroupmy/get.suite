import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleFromText, mailLink, eventFromMessage, dueFromText } from './addtask.js';

test('a chat message becomes a short plain title', () => {
  assert.equal(titleFromText('\n  **Send** the _quote_ to Raj  \nthanks'), 'Send the quote to Raj');
  assert.equal(titleFromText('x'.repeat(300)).length, 200);
  assert.equal(titleFromText(''), '');
});

test('an email links by Message-ID when it has one', () => {
  assert.equal(mailLink({ messageId: '<a+b@x.com>', folder: 'INBOX', uid: 4 }), '/mail?open=%3Ca%2Bb%40x.com%3E');
  assert.equal(mailLink({ messageId: null, folder: 'Work/Q1', uid: 4 }), '/mail/Work%2FQ1/4');
});

test('a chat message as a new event: its first line as the title, the next half hour, what it says and a link back', () => {
  const now = new Date(2026, 10, 23, 9, 10).getTime();
  const e = eventFromMessage({ body: '**Demo** for Globex\nThursday works for them', user_name: 'Kim Park' }, 'https://ws.test/chat/c1?msg=m1', now);
  assert.deepEqual([e.title, new Date(e.start).getHours(), new Date(e.start).getMinutes(), e.end - e.start, e.all_day], ['Demo for Globex', 9, 30, 36e5, 0]);
  assert.equal(e.description, '**Demo** for Globex\nThursday works for them\n\nFrom Kim Park in Chat: https://ws.test/chat/c1?msg=m1');
  assert.deepEqual([eventFromMessage({}, '', now).title, eventFromMessage({}, '', now).description], ['', '']);
});

test('a chat message that names a day or time: the event is then, and the words for it leave the title', () => {
  const now = new Date(2026, 10, 23, 9, 10).getTime(); // a Monday
  const at = (e) => [e.title, new Date(e.start).getDate(), new Date(e.start).getHours(), new Date(e.start).getMinutes(), e.all_day];
  assert.deepEqual(at(eventFromMessage({ body: 'Demo for Globex thursday 3pm\nBring the deck' }, '', now)), ['Demo for Globex', 26, 15, 0, 0]);
  const lunch = eventFromMessage({ body: 'Lunch tomorrow' }, '', now);
  assert.deepEqual([lunch.title, new Date(lunch.start).getDate(), lunch.all_day], ['Lunch', 24, 1]);
  // The whole message stays in the description; a line with no day or time is the next half hour, as before.
  assert.match(eventFromMessage({ body: 'Demo for Globex thursday 3pm\nBring the deck' }, '', now).description, /^Demo for Globex thursday 3pm\nBring the deck/);
  assert.deepEqual(at(eventFromMessage({ body: 'Demo for Globex' }, '', now)), ['Demo for Globex', 23, 9, 30, 0]);
});

test('a task from a message is due on the day its first line names; nothing when it names none', () => {
  const now = new Date(2026, 10, 23, 9, 10).getTime(); // a Monday
  assert.deepEqual(dueFromText('Send the quote by **friday**\nthanks', now), { due: '2026-11-27' });
  assert.deepEqual(dueFromText('Call Raj tomorrow', now), { due: '2026-11-24' });
  assert.deepEqual(dueFromText('Nothing dated here\nbut friday on the second line', now), {});
  assert.deepEqual(dueFromText('', now), {});
});
