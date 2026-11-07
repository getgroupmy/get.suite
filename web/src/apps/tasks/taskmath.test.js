import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueLabel, between } from './taskmath.js';

test('due dates in words, with a tone', () => {
  const now = new Date(2026, 10, 6, 15, 0); // Fri 6 Nov 2026, afternoon
  assert.deepEqual(dueLabel('2026-11-06', now), { text: 'Today', tone: 'soon' });
  assert.deepEqual(dueLabel('2026-11-07', now), { text: 'Tomorrow', tone: 'soon' });
  assert.deepEqual(dueLabel('2026-11-05', now), { text: 'Yesterday', tone: 'late' });
  assert.equal(dueLabel('2026-11-01', now).tone, 'late');
  assert.equal(dueLabel('2026-11-20', now).tone, '');
  assert.match(dueLabel('2027-01-02', now).text, /2027/, 'another year says which');
  assert.doesNotMatch(dueLabel('2026-12-02', now).text, /2026/);
  assert.deepEqual(dueLabel('2026-11-07', now, '15:30'), { text: 'Tomorrow 15:30', tone: 'soon' });
  assert.deepEqual(dueLabel('2026-11-06', now, '14:00'), { text: 'Today 14:00', tone: 'late' }, 'its time has passed');
  assert.deepEqual(dueLabel('2026-11-06', now, '16:00'), { text: 'Today 16:00', tone: 'soon' });
});

test('a dragged task lands between its neighbours', () => {
  assert.equal(between(undefined, undefined), 0);
  assert.equal(between(undefined, 3), 2);
  assert.equal(between(3, undefined), 4);
  assert.equal(between(1, 2), 1.5);
});

test('local today and repeat wording', async () => {
  const { localToday, repeatText, REPEATS } = await import('./taskmath.js');
  assert.equal(localToday(new Date(2026, 0, 5, 23, 30)), '2026-01-05');
  assert.equal(repeatText('weekdays'), 'Weekdays');
  assert.equal(repeatText(null), '');
  assert.deepEqual(REPEATS.map(([v]) => v), ['', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly']);
});

test('sorting a list', async () => {
  const { sortTasks } = await import('./taskmath.js');
  const t = [
    { id: 'a', title: 'Zebra', due: null, created_at: 1 },
    { id: 'b', title: 'apple', due: '2026-11-10', due_time: '15:00', created_at: 3, important: true },
    { id: 'c', title: 'Item 10', due: '2026-11-10', created_at: 2 },
    { id: 'd', title: 'Item 9', due: '2026-11-09', created_at: 4 },
    { id: 'e', title: 'Mango', due: '2026-11-10', due_time: '09:00', created_at: 5 },
  ];
  const ids = (s) => sortTasks(t, s).map((x) => x.id).join('');
  assert.equal(ids('mine'), 'abcde');
  assert.equal(ids('due'), 'debca', 'by date, timed ones first on a day, undated last');
  assert.equal(ids('title'), 'bdcea', 'case doesn’t matter; numbers in order');
  assert.equal(ids('added'), 'edbca');
  assert.equal(ids('important'), 'bacde');
});
