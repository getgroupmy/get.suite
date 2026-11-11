import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nudgeQuery, NO_NUDGE } from '../src/mail/nudges.js';
import { tabQuery } from '../src/mail/tabs.js';

test('nudges: unanswered mail in Primary from 3 to 14 days ago, not dismissed', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const qy = nudgeQuery(now);
  assert.deepEqual(qy.not, tabQuery('primary').not, 'the Primary tab');
  assert.equal(qy.since.toISOString(), '2026-11-06T12:00:00.000Z');
  assert.equal(qy.before.toISOString(), '2026-11-17T12:00:00.000Z');
  assert.equal(qy.answered, false);
  assert.equal(qy.unKeyword, NO_NUDGE);
});
