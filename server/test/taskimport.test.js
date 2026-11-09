import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tasksFromCsv, dateOf } from '../src/taskimport.js';
import { tasksCsv } from '../src/routes/tasks.js';

test('dates written the usual ways', () => {
  assert.equal(dateOf('2026-12-01'), '2026-12-01');
  assert.equal(dateOf('2026-12-01T09:00:00Z'), '2026-12-01');
  assert.equal(dateOf('1/12/2026'), '2026-12-01', 'day first');
  assert.equal(dateOf('12/25/2026'), '2026-12-25', 'unless it can only be month first');
  assert.equal(dateOf('1.12.26'), '2026-12-01');
  assert.equal(dateOf('Dec 1, 2026'), '2026-12-01');
  assert.equal(dateOf('31/02/2026'), null);
  assert.equal(dateOf('soon'), null);
});

test('a simple sheet: only a task column needed; empty rows skipped', () => {
  const r = tasksFromCsv('Title;Due date;Priority\nBuy milk;3/1/2027;high\n;;\nCall Bob;;\n');
  assert.equal(r.skipped, 0, 'blank lines are not rows');
  assert.deepEqual(r.tasks.map((t) => [t.title, t.due, t.important]), [['Buy milk', '2027-01-03', true], ['Call Bob', null, false]]);
  assert.match(tasksFromCsv('Name\n\n').error || '', /empty|Task/i, 'a header alone gives nothing');
  assert.match(tasksFromCsv('Foo,Bar\n1,2').error, /Task/);
});

test('a list downloaded from Workspace comes back the same', () => {
  const csv = tasksCsv([
    { title: 'Write copy', done: false, started: false, due: '2026-12-01', due_time: '09:30', start: '2026-11-20', important: true, tags: ['web', 'q4'], steps: [{ title: 'Draft', done: true }, { title: 'Review', done: false }], notes: 'Short\nand sweet' },
    { title: 'Book room', done: true, done_at: Date.UTC(2026, 10, 5), steps: [], tags: [] },
  ]);
  const { tasks, skipped } = tasksFromCsv(csv);
  assert.equal(skipped, 0);
  assert.deepEqual(tasks[0], { title: 'Write copy', notes: 'Short\nand sweet', due: '2026-12-01', due_time: '09:30', start: '2026-11-20', tags: ['web', 'q4'], done: false, important: true,
    steps: [{ title: 'Draft', done: true }, { title: 'Review', done: false }] });
  assert.equal(tasks[1].done, true);
});
