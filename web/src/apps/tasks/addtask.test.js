import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleFromText, mailLink, eventFromMessage } from './addtask.js';

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
