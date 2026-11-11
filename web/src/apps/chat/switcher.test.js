import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchScore, jumpChoices, jumpItems } from './switcher.js';

test('how well a name matches', () => {
  assert.equal(matchScore('#design-team', 'des'), 0);
  assert.equal(matchScore('#design-team', '#des'), 0);
  assert.equal(matchScore('#design-team', 'team'), 1);
  assert.equal(matchScore('Kim Park', 'park'), 1);
  assert.equal(matchScore('Kim Park', 'ark'), 2);
  assert.equal(matchScore('Kim Park', 'zz'), -1);
});

const channels = [
  { id: 'g', name: 'general' },
  { id: 'd', name: 'design-team', private: 1 },
  { id: 'old', name: 'design-old', left: true },
  { id: 'k', dm_key: 'x', dm_name: 'Kim Park', dm_user_id: 'kim' },
];
const people = [{ id: 'me', name: 'Olivia Owner' }, { id: 'kim', name: 'Kim Park' }, { id: 'dan', name: 'Dan Designer', username: 'dan@acme.com', job_title: 'Designer' }];

test('conversations, then colleagues without a direct message yet', () => {
  const items = jumpItems(channels, people, { g: 2 }, 'me');
  assert.deepEqual(items.map((i) => `${i.kind}:${i.id}`), ['channel:g', 'channel:d', 'dm:k', 'person:dan']);
  assert.equal(items[0].unread, 2);
});

test('best matches first; unread ones first when as good', () => {
  const items = jumpItems(channels, people, { d: 1 }, 'me');
  assert.deepEqual(jumpChoices(items, 'des').map((i) => i.id), ['d', 'dan'], 'channel starts with it; Dan has a word starting with it');
  assert.deepEqual(jumpChoices(items, 'dan@').map((i) => i.id), ['dan'], 'by address too');
  assert.deepEqual(jumpChoices(items, '').map((i) => i.id), ['d', 'g', 'k'], 'nothing typed: unread first, no people');
  assert.deepEqual(jumpChoices(items, 'zzz'), []);
  assert.equal(jumpChoices(items, 'e', 2).length, 2);
});
