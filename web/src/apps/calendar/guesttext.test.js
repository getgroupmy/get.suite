import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestsFromText } from './guesttext.js';

test('plain addresses, however they are separated', () => {
  assert.deepEqual(guestsFromText('Kim@Acme.com, raj@acme.com;ana@x.org\nbo@y.org').map((g) => g.email), ['kim@acme.com', 'raj@acme.com', 'ana@x.org', 'bo@y.org']);
  assert.deepEqual(guestsFromText('kim@acme.com raj@acme.com').map((g) => g.email), ['kim@acme.com', 'raj@acme.com']);
  assert.deepEqual(guestsFromText('kim@acme.com,'), [{ name: '', email: 'kim@acme.com' }]);
});

test('a To line copied from an email: names kept, brackets gone', () => {
  assert.deepEqual(guestsFromText('Ann Lee <ann@x.org>, "Stone, Ada" <ADA@initrode.example>; ben@y.org'), [
    { name: 'Ann Lee', email: 'ann@x.org' }, { name: 'Stone, Ada', email: 'ada@initrode.example' }, { name: '', email: 'ben@y.org' }]);
  assert.deepEqual(guestsFromText('<ann@x.org>').map((g) => g.email), ['ann@x.org']);
  assert.deepEqual(guestsFromText('write to (ann@x.org).').map((g) => g.email), ['ann@x.org']);
});

test('each address once; what is no address is left out', () => {
  assert.deepEqual(guestsFromText('ann@x.org, Ann <ANN@x.org>').map((g) => g.email), ['ann@x.org']);
  assert.deepEqual(guestsFromText('lunch with kim'), []);
  assert.deepEqual(guestsFromText('kim@acme'), []);
  assert.deepEqual(guestsFromText(''), []);
});
