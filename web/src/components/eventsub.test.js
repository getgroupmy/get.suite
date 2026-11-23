import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventWhen, eventSub } from './eventsub.js';

const now = new Date(2026, 10, 23, 12).getTime(); // Monday 23 Nov 2026, noon
const at = (m, d, h, min = 0, y = 2026) => new Date(y, m - 1, d, h, min).getTime();

test('when an event is, in words', () => {
  assert.equal(eventWhen(at(11, 23, 15), false, now), 'Today 15:00');
  assert.equal(eventWhen(at(11, 24, 9, 30), false, now), 'Tomorrow 09:30');
  assert.equal(eventWhen(at(11, 22, 18), false, now), 'Yesterday 18:00');
  assert.equal(eventWhen(at(11, 28, 0), true, now), 'Sat 28 Nov, all day');
  assert.equal(eventWhen(at(12, 15, 10), false, now), '15 Dec 10:00');
  assert.equal(eventWhen(at(1, 3, 10, 0, 2027), false, now), '3 Jan 2027 10:00', 'another year says so');
  assert.equal(eventWhen(at(11, 2, 10), false, now), '2 Nov 10:00');
});

test('an event\'s line in search results', () => {
  assert.equal(eventSub({ start: at(11, 24, 9), location: 'Room 4', repeats: true, role: 'organizer' }, now), 'Tomorrow 09:00 · Room 4 · 🔁');
  assert.equal(eventSub({ start: at(11, 24, 9), role: 'guest', my_status: 'needs', upcoming: true }, now), 'Tomorrow 09:00 · not answered yet');
  assert.equal(eventSub({ start: at(11, 24, 9), role: 'guest', my_status: 'yes', upcoming: true }, now), 'Tomorrow 09:00', 'a yes needs no saying');
  assert.equal(eventSub({ start: at(11, 2, 9), role: 'guest', my_status: 'needs', upcoming: false }, now), '2 Nov 09:00', 'nor an answer to something past');
});
