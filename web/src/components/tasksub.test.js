import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueText, taskSub } from './tasksub.js';

const today = '2026-11-23'; // a Monday

test('due dates in words, as Tasks says them', () => {
  assert.equal(dueText(null, today), null);
  assert.equal(dueText('2026-11-23', today), 'due today');
  assert.equal(dueText('2026-11-23', today, '15:30'), 'due today 15:30');
  assert.equal(dueText('2026-11-24', today), 'due tomorrow');
  assert.equal(dueText('2026-11-28', today), 'due Sat 28 Nov');
  assert.equal(dueText('2026-12-15', today), 'due 15 Dec');
  assert.equal(dueText('2027-01-03', today), 'due 3 Jan 2027', 'another year says so');
  assert.equal(dueText('2026-11-22', today), 'overdue since yesterday');
  assert.equal(dueText('2026-11-02', today), 'overdue since 2 Nov');
  assert.equal(dueText('2026-12-31', '2026-12-30'), 'due tomorrow', 'across the month');
  assert.equal(dueText('2027-01-01', '2026-12-31'), 'due tomorrow', 'and the year');
});

test('a task\'s line in search results', () => {
  assert.equal(taskSub({ list_name: 'Office move', due: '2026-11-24', assignee_name: 'Kim Park', priority: 'high', important: 1 }, today), 'Office move · due tomorrow · Kim Park · high priority · ★');
  assert.equal(taskSub({ list_name: 'Home' }, today), 'Home', 'nothing more to say');
  assert.equal(taskSub({ list_name: 'Home', due: '2026-11-01', done_at: 1, assignee_name: 'Kim Park', priority: 'medium', important: 1 }, today), 'Home · Kim Park', 'a done one isn\'t overdue or urgent');
});

test('a task found by one of its comments says so first', () => {
  assert.equal(taskSub({ list_name: 'Launch', done_at: 1, comment_match: 'Hall,\n cheaper' }, '2026-11-26'), '💬 “Hall, cheaper” · Launch');
  assert.equal(taskSub({ list_name: 'Launch', done_at: 1 }, '2026-11-26'), 'Launch');
});
