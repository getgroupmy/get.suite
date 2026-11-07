import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleFromText, mailLink } from './addtask.js';

test('a chat message becomes a short plain title', () => {
  assert.equal(titleFromText('\n  **Send** the _quote_ to Raj  \nthanks'), 'Send the quote to Raj');
  assert.equal(titleFromText('x'.repeat(300)).length, 200);
  assert.equal(titleFromText(''), '');
});

test('an email links by Message-ID when it has one', () => {
  assert.equal(mailLink({ messageId: '<a+b@x.com>', folder: 'INBOX', uid: 4 }), '/mail?open=%3Ca%2Bb%40x.com%3E');
  assert.equal(mailLink({ messageId: null, folder: 'Work/Q1', uid: 4 }), '/mail/Work%2FQ1/4');
});
