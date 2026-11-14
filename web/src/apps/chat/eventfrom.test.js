import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventFromChat } from './eventfrom.js';

const today = '2026-11-13'; // a Friday
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();
const me = { id: 'me', username: 'me@acme.com', name: 'Me Myself' };
const kim = { id: 'k', username: 'kim@acme.com', name: 'Kim Park' };
const ana = { id: 'a', username: 'Ana@acme.com', name: 'Ana Silva' };
const bo = { id: 'b', username: 'bo@acme.com', name: 'Bo Diaz' };
const directory = [me, kim, ana, bo];

test('a direct message or private channel: everyone in it is invited, at the time asked', () => {
  const { ev, findTime } = eventFromChat('Planning tomorrow 3pm for 30m', { channel: { id: 'c1', private: 1, name: 'launch' }, members: [me, kim, ana], directory, me, today });
  assert.equal(findTime, false);
  assert.deepEqual([ev.title, ev.start, ev.end, ev.from_chat], ['Planning', at(14, 15), at(14, 15, 30), 'c1']);
  assert.deepEqual(ev.guests, [{ email: 'kim@acme.com', name: 'Kim Park' }, { email: 'ana@acme.com', name: 'Ana Silva' }]);
});

test('an open channel: only the people named with @ (and addresses)', () => {
  const { ev } = eventFromChat('Review with @bo and jo@client.example friday 10am', { channel: { id: 'g', name: 'general' }, members: [me, kim, ana, bo], directory, me, today });
  assert.equal(ev.title, 'Review with Bo');
  assert.deepEqual(ev.guests, [{ email: 'bo@acme.com', name: 'Bo Diaz' }, { email: 'jo@client.example' }]);
});

test('no day or time: the words are the title and the first free time is found; alone, the channel name', () => {
  const r = eventFromChat('Retro', { channel: { id: 'c1', private: 1, name: 'launch' }, members: [me, kim], directory, me, today });
  assert.deepEqual([r.findTime, r.ev.title, r.ev.start], [true, 'Retro', undefined]);
  assert.equal(eventFromChat('', { channel: { id: 'c1', private: 1, name: 'launch' }, members: [me, kim], directory, me, today }).ev.title, 'launch');
  assert.equal(eventFromChat('', { channel: { id: 'd', dm_key: 'x' }, members: [me, kim], directory, me, today }).ev.title, '', 'a DM has no name to use');
});

test('repeats and rooms come along; an @name already here is invited once; too many people: an error', () => {
  const { ev } = eventFromChat('1:1 with @kim every 2 weeks on tue 10am in Lisbon', { channel: { id: 'd', dm_key: 'x' }, members: [me, kim], directory, rooms: [{ id: 'l', name: 'Lisbon' }], me, today });
  assert.deepEqual(ev.rrule, { freq: 'weekly', interval: 2, byday: [2] });
  assert.deepEqual(ev.pick_rooms, ['l']);
  assert.deepEqual(ev.guests.map((g) => g.email), ['kim@acme.com']);
  const crowd = Array.from({ length: 22 }, (_, i) => ({ id: `u${i}`, username: `u${i}@acme.com`, name: `U ${i}` }));
  assert.match(eventFromChat('Party friday 5pm', { channel: { id: 'p', private: 1, name: 'all' }, members: [me, ...crowd], directory, me, today }).error, /At most 20/);
});

test('a turned-off member of a private channel isn\'t invited', () => {
  const { ev } = eventFromChat('Sync tomorrow 9am', { channel: { id: 'c', private: 1, name: 'x' }, members: [me, kim, { ...bo, disabled: true }], directory, me, today });
  assert.deepEqual(ev.guests.map((g) => g.email), ['kim@acme.com']);
});
