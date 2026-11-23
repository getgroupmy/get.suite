import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colleaguesFor, colleagueAddress } from './colleagues.js';

const people = [{ id: 1, name: 'Kim Park', username: 'kim@acme.com' }, { id: 2, name: 'Kimberly Ortíz', username: 'kimberly@acme.com' }, { id: 3, name: 'Raj Patel', username: 'raj@acme.com' }];

test('colleagues by the words of a name, accents aside; none once an address is exact', () => {
  assert.deepEqual(colleaguesFor(people, 'park kim').map((p) => p.id), [1]);
  assert.deepEqual(colleaguesFor(people, 'kim').map((p) => p.id), [1, 2]);
  assert.deepEqual(colleaguesFor(people, 'ortiz').map((p) => p.id), [2]);
  assert.deepEqual(colleaguesFor(people, 'KIM@acme.com'), []);
  assert.deepEqual(colleaguesFor(people, '  '), []);
  assert.equal(colleaguesFor(people, 'a', 2).length, 2);
});

test('the address meant: the one typed, or that of the only colleague a name fits', () => {
  assert.equal(colleagueAddress(people, ' Someone@Else.example '), 'someone@else.example');
  assert.equal(colleagueAddress(people, 'raj'), 'raj@acme.com');
  assert.equal(colleagueAddress(people, 'kim'), null, 'two people fit');
  assert.equal(colleagueAddress(people, 'nobody'), null);
});
