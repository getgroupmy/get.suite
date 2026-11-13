import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followUpEmail } from './followup.js';

test('to everyone who joined but you, once each; guests without an address left out; notes linked', () => {
  const m = followUpEmail({ title: 'Weekly <review>', me: 'OLI@acme.com', notesLink: 'https://x/docs/1',
    people: [{ name: 'Olivia', email: 'oli@acme.com' }, { name: 'Kim "K" Park', email: 'kim@acme.com' }, { name: 'Kim again', email: 'KIM@acme.com' }, { name: 'Gina (guest)', email: null }, { name: 'raj@x.com', email: 'raj@x.com' }] });
  assert.equal(m.to, '"Kim K Park" <kim@acme.com>, raj@x.com');
  assert.equal(m.subject, 'Follow-up: Weekly <review>');
  assert.match(m.html, /Thanks for joining Weekly &lt;review&gt;\./);
  assert.match(m.html, /<a href="https:\/\/x\/docs\/1">Meeting notes<\/a>/);
  assert.doesNotMatch(followUpEmail({ title: 'X', people: [] }).html, /Meeting notes/);
});

test('the kept chat linked too, when there is one', () => {
  const m = followUpEmail({ title: 'X', people: [{ email: 'a@b.c' }], chatLink: 'https://x/meet?chat=abc-defg-hij' });
  assert.match(m.html, /<a href="https:\/\/x\/meet\?chat=abc-defg-hij">The meeting chat<\/a>/);
  assert.doesNotMatch(followUpEmail({ title: 'X', people: [] }).html, /meeting chat/);
});
