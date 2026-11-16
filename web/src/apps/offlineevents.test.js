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
