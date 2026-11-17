import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextMeeting } from './nextmeeting.js';

const now = Date.UTC(2026, 10, 17, 9, 0);
const m = (title, startMin, len = 30, more = {}) => ({ title, start: now + startMin * 60e3, end: now + (startMin + len) * 60e3, ...more });
test('the meeting starting within 15 minutes, or going on now', () => {
  assert.equal(nextMeeting([m('Later', 40)], now), null, 'too far off');
  assert.deepEqual(nextMeeting([m('Stand-up', 5)], now).label, 'in 5 min');
  assert.equal(nextMeeting([m('Review', 12), m('Stand-up', 5)], now).ev.title, 'Stand-up', 'the soonest');
  assert.equal(nextMeeting([m('Workshop', -10, 60), m('Stand-up', 5)], now).ev.title, 'Workshop', 'one under way first');
  assert.equal(nextMeeting([m('Workshop', -10, 60)], now).label, 'started 10 min ago');
  assert.equal(nextMeeting([m('Now', 0)], now).label, 'now');
  assert.equal(nextMeeting([m('Done', -40)], now), null, 'over');
});
test('not all-day events, declined ones, out of office or focus time', () => {
  assert.equal(nextMeeting([m('Holiday', 5, 30, { all_day: 1 })], now), null);
  assert.equal(nextMeeting([m('Declined', 5, 30, { my_status: 'no' })], now), null);
  assert.equal(nextMeeting([m('Away', 5, 30, { kind: 'ooo' })], now), null);
  assert.equal(nextMeeting([m('Deep work', 5, 30, { kind: 'focus' })], now), null);
});
