import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionQuery, matchPeople } from './mention.js';

test('the @word being typed', () => {
  assert.deepEqual(mentionQuery('Ask @ki', 20), { from: 17, query: 'ki' });
  assert.deepEqual(mentionQuery('@', 1), { from: 0, query: '' });
  assert.equal(mentionQuery('mail me@acme', 12), null, 'not inside an email address');
  assert.equal(mentionQuery('Ask @kim park', 13), null, 'a space ends it');
});

test('people matching it, names starting with it first', () => {
  const people = [{ name: 'Bob Kim', username: 'bob@acme.com' }, { name: 'Kim Park', username: 'kim@acme.com' }, { name: 'Ann Lee', username: 'ann@acme.com' }];
  assert.deepEqual(matchPeople(people, 'kim').map((p) => p.name), ['Kim Park', 'Bob Kim']);
  assert.deepEqual(matchPeople(people, 'ANN@').map((p) => p.name), ['Ann Lee']);
  assert.equal(matchPeople(people, '').length, 3);
});
