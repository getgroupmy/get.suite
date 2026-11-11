import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortContacts } from './sortcontacts.js';

const people = [
  { name: 'Zoe Adams', company: 'Beta', created_at: 1 },
  { name: 'anna Young', company: '', created_at: 3 },
  { name: 'Bob Martin', company: 'Acme', created_at: 2, starred: 1 },
  { name: 'Cher', company: 'Acme', created_at: 4 },
];
const names = (l) => l.map((c) => c.name);

test('sorting contacts, starred first', () => {
  assert.deepEqual(names(sortContacts(people, 'first')), ['Bob Martin', 'anna Young', 'Cher', 'Zoe Adams']);
  assert.deepEqual(names(sortContacts(people, 'last')), ['Bob Martin', 'Zoe Adams', 'Cher', 'anna Young']);
  assert.deepEqual(names(sortContacts(people, 'company')), ['Bob Martin', 'Cher', 'Zoe Adams', 'anna Young']);
  assert.deepEqual(names(sortContacts(people, 'added')), ['Bob Martin', 'Cher', 'anna Young', 'Zoe Adams']);
  assert.equal(people[0].name, 'Zoe Adams', 'the list given is left alone');
});
