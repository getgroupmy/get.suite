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

test('last in touch: most recent first, never last; and how long ago it was', async () => {
  const { sortContacts, touchAgo } = await import('./sortcontacts.js');
  const now = Date.UTC(2026, 10, 17, 12);
  const list = [{ name: 'Never' }, { name: 'Old', last_contact: now - 40 * 864e5 }, { name: 'Fresh', last_contact: now - 2 * 864e5 }, { name: 'Starred never', starred: true }];
  assert.deepEqual(sortContacts(list, 'touch').map((c) => c.name), ['Starred never', 'Fresh', 'Old', 'Never']);
  assert.deepEqual([null, now - 3600e3, now - 864e5, now - 3 * 864e5, now - 40 * 864e5, now - 200 * 864e5, now - 800 * 864e5].map((t) => touchAgo(t, now)),
    ['Not in touch yet', 'In touch today', 'In touch yesterday', 'In touch 3 days ago', 'In touch 6 weeks ago', 'In touch 7 months ago', 'In touch 2 years ago']);
});
