import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyNames, othersAt } from './companies.js';

const contacts = [
  { id: 1, name: 'Ben Vale', company: 'Initrode Works' }, { id: 2, name: 'ada stone', company: ' initrode  works ' }, { id: 3, name: 'Cy Marsh', company: 'Initrode Works' },
  { id: 4, name: 'Zoë', company: 'Café Olé' }, { id: 5, name: 'Dee', company: '' }, { id: 6, name: 'Eve' }, { id: 7, name: 'Finn', company: 'acme' },
];

test('each company once, as most often written, A to Z', () => {
  assert.deepEqual(companyNames(contacts), ['acme', 'Café Olé', 'Initrode Works']);
  assert.deepEqual(companyNames([]), []);
  assert.deepEqual(companyNames([{ company: 'b Ltd' }, { company: 'B Ltd' }]), ['b Ltd'], 'a tie: the first in the alphabet');
});

test('who else is at a company: spelling, accents and spacing aside; not the contact itself', () => {
  assert.deepEqual(othersAt(contacts, contacts[0]).map((c) => c.id), [2, 3]);
  assert.deepEqual(othersAt(contacts, { company: 'INITRODE WORKS' }).map((c) => c.id), [2, 1, 3], 'a new contact being typed');
  assert.deepEqual(othersAt(contacts, { company: 'cafe ole' }).map((c) => c.id), [4]);
  assert.deepEqual(othersAt(contacts, contacts[4]), []);
  assert.deepEqual(othersAt(contacts, contacts[6]), []);
});
