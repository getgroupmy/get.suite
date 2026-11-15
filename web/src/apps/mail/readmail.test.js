import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailSentences } from './readmail.js';

test('an email read aloud: who and what, then its sentences, without quotes or the signature', () => {
  const said = mailSentences({
    subject: 'Site visit on Friday',
    from: { name: 'Raj Kumar', address: 'raj@acme.com' },
    text: 'Hi Olivia,\n\nThe visit is at 10. Please bring the\nplans and the permits.\n\n> earlier quoted line\n\nThanks!\n-- \nRaj Kumar\nSite manager\n',
  });
  assert.deepEqual(said.map((s) => s.text), ['From Raj Kumar.', 'Site visit on Friday.', 'Hi Olivia,', 'The visit is at 10.', 'Please bring the plans and the permits.', 'Thanks!']);
});

test('a reply’s history is left out; a subject ending in ? keeps it', () => {
  const said = mailSentences({ subject: 'Lunch?', from: { address: 'kim@acme.com' }, text: 'Yes, 1pm works.\n\nOn Mon, 3 Nov 2026 at 09:00, Olivia <olivia@acme.com> wrote:\nShall we have lunch?\n' });
  assert.deepEqual(said.map((s) => s.text), ['From kim@acme.com.', 'Lunch?', 'Yes, 1pm works.']);
  assert.deepEqual(mailSentences({}), []);
});
