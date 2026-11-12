import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshOn } from './api.js';

test('refreshOn: the types named, or the live connection coming (back) up', () => {
  assert.equal(refreshOn({ type: 'events-changed' }, 'events-changed'), true);
  assert.equal(refreshOn({ type: 'live-connected' }, 'events-changed'), true, 'catch up after a reconnect');
  assert.equal(refreshOn({ type: 'tasks-changed' }, 'events-changed', 'calendar-shares'), false);
  assert.equal(refreshOn({ type: 'calendar-shares' }, 'events-changed', 'calendar-shares'), true);
});
