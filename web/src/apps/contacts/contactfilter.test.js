import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesFilter } from './contactfilter.js';

const bob = { id: 1, name: 'Bob Martin', company: 'Acme', email: 'bob@acme.test', phone: '+1 (555) 01-42', notes: 'Met in Zürich', starred: 1 };

test('nothing typed fits everyone', () => {
  assert.equal(matchesFilter(bob, ''), true);
  assert.equal(matchesFilter(bob, '   '), true);
});

test('words may be in different fields, in any order', () => {
  assert.equal(matchesFilter(bob, 'martin acme'), true);
  assert.equal(matchesFilter(bob, 'ACME bob'), true);
  assert.equal(matchesFilter(bob, 'zurich mart'), true);
  assert.equal(matchesFilter(bob, 'martin globex'), false);
});

test('a phrase inside one field still fits', () => {
  assert.equal(matchesFilter(bob, 'Bob Mar'), true);
  assert.equal(matchesFilter(bob, 'met in'), true);
});

test('a number is found however the phone is written', () => {
  assert.equal(matchesFilter(bob, '5550142'), true);
  assert.equal(matchesFilter(bob, '555-0142'), true);
  assert.equal(matchesFilter(bob, '555 0142'), true);
  assert.equal(matchesFilter(bob, '(555) 0142'), true);
  assert.equal(matchesFilter(bob, 'bob 0142'), true);
  assert.equal(matchesFilter(bob, '5550143'), false);
  assert.equal(matchesFilter(bob, '12'), false); // too short to be a number search; no field has "12"
});

test('a contact without a phone is not found by a number', () => {
  assert.equal(matchesFilter({ name: 'Ann' }, '555'), false);
  assert.equal(matchesFilter({ name: 'Ann', notes: 'room 555' }, '555'), true);
});

test('other numbers of the contact are found too, each on its own', () => {
  const c = { name: 'Ann', phone: '555 0100', more_phones: JSON.stringify([{ label: 'Work', value: '(020) 7946-0018' }]) };
  assert.equal(matchesFilter(c, '79460018'), true);
  assert.equal(matchesFilter({ ...c, more_phones: [{ label: 'Work', value: '(020) 7946-0018' }] }, '020 7946'), true);
  assert.equal(matchesFilter(c, '0100020'), false); // not across two numbers
});
