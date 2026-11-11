import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tooSmall, roomLine, sortRooms, readFeatures } from './roomfit.js';

test('a room in one line', () => {
  assert.equal(roomLine({ name: 'Boardroom', capacity: 12, location: '2nd floor', features: ['Video', 'Whiteboard'] }), 'Boardroom (12) · 2nd floor · Video, Whiteboard');
  assert.equal(roomLine({ name: 'Projector', capacity: null, location: null, features: [] }), 'Projector');
});

test('too small for the people coming', () => {
  assert.equal(tooSmall({ capacity: 4 }, 5), true);
  assert.equal(tooSmall({ capacity: 4 }, 4), false);
  assert.equal(tooSmall({ capacity: null }, 50), false);
});

test('best rooms first: free, big enough, smallest that fits', () => {
  const rooms = [
    { name: 'Hall', capacity: 40, free: true }, { name: 'Pod', capacity: 2, free: true }, { name: 'Taken', capacity: 6, free: false },
    { name: 'Meeting', capacity: 6, free: true }, { name: 'Car', capacity: null, free: true },
  ];
  assert.deepEqual(sortRooms(rooms, 5).map((r) => r.name), ['Meeting', 'Hall', 'Car', 'Pod', 'Taken']);
  assert.deepEqual(sortRooms([{ name: 'B' }, { name: 'A' }]).map((r) => r.name), ['A', 'B'], 'by name when nothing else tells');
});

test('equipment typed with commas', () => {
  assert.deepEqual(readFeatures(' Video, whiteboard ,video,, Screen   share '), ['Video', 'whiteboard', 'Screen share']);
  assert.deepEqual(readFeatures(''), []);
});

test('how a room is doing right now', async () => {
  const { nowText } = await import('./roomfit.js');
  const time = (t) => `T${t}`;
  assert.equal(nowText({ busy: null, next: null }, time), 'Free for the next 12 hours');
  assert.equal(nowText({ busy: null, next: { start: 5, title: 'X' } }, time), 'Free until T5');
  assert.equal(nowText({ busy: { title: 'Standup', organizer: 'Olivia', until: 9 }, next: null }, time), 'In use until T9: Standup (Olivia)');
});
