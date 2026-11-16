import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsCovering, offlineId } from './offlinedocs.js';

test('an event made offline goes into the kept Calendar lists whose dates take it in', () => {
  const pick = eventsCovering(1000, 2000);
  assert.equal(pick('u1::/events?from=0&to=5000'), true);
  assert.equal(pick('u1::/events?from=1500&to=1600'), true, 'a day inside it');
  assert.equal(pick('u1::/events?from=2001&to=5000'), false, 'after it');
  assert.equal(pick('u1::/events?from=0&to=999'), false, 'before it');
  assert.equal(pick('u1::/notes?'), false);
  assert.equal(pick('u1::/events?from=0&to=5000&x=1'), false);
});

test('ids for things made offline are ones the server takes', () => {
  const a = offlineId(), b = offlineId();
  assert.match(a, /^[A-Za-z0-9_-]{16,40}$/);
  assert.notEqual(a, b);
});

test('sending what was kept offline: "not now" answers keep it for the next try, refusals drop it', async () => {
  const { tryLater } = await import('./offlinedocs.js');
  assert.equal(tryLater(new TypeError('Failed to fetch')), true, 'no connection');
  for (const status of [401, 408, 429, 500, 502, 503, 504]) assert.equal(tryLater({ status }), true, String(status));
  for (const status of [400, 403, 404, 409, 413, 422]) assert.equal(tryLater({ status }), false, String(status));
});

test('an opened message is kept under the reader’s address; a peek (kept ahead, or printed) isn’t kept twice', async () => {
  const { OFFLINE_READS } = await import('./offlinedocs.js');
  const kept = (url) => OFFLINE_READS.some((re) => re.test(url));
  assert.equal(kept('/mail/messages/42?folder=INBOX'), true);
  assert.equal(kept('/mail/messages/42?folder=Archive%2F2024'), true);
  assert.equal(kept('/mail/messages/42?folder=INBOX&peek=1'), false);
  assert.equal(kept('/mail/messages?folder=INBOX&page=1'), true);
});
