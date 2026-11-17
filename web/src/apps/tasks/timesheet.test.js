import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekDays, timesheet, timesheetCsv, hm } from './timesheet.js';

const mon = new Date(2026, 10, 16).getTime(); // Monday 16 November, local midnight
const h = 36e5;
const tasks = [{ id: 'a', title: 'Design', list_id: 'L' }, { id: 'b', title: 'Report, Q4', list_id: 'L' }, { id: 'c', title: 'Idle', list_id: 'L' }];

test('the week’s days', () => {
  const d = weekDays(mon);
  assert.equal(d.length, 7);
  assert.equal(d[0].date, '2026-11-16');
  assert.equal(d[6].date, '2026-11-22');
  assert.equal(d[1].start, d[0].end);
});

test('a row per task with time, a cell per day; timers split at midnight, logged time on its date', () => {
  const tue = mon + 24 * h;
  const sheet = timesheet([
    { task_id: 'a', start: tue + 9 * h, end: tue + 10.5 * h },
    { task_id: 'a', start: tue + 23 * h, end: tue + 25 * h }, // 1 h Tuesday, 1 h Wednesday
    { task_id: 'b', start: Date.UTC(2026, 10, 20, 12), minutes: 45, logged: true }, // Friday
    { task_id: 'x', start: tue, end: tue + h }, // a task not given: left out
  ], tasks, mon);
  assert.deepEqual(sheet.rows.map((r) => [r.title, r.cells, r.total]), [
    ['Design', [0, 150, 60, 0, 0, 0, 0], 210],
    ['Report, Q4', [0, 0, 0, 0, 45, 0, 0], 45],
  ]);
  assert.deepEqual(sheet.dayTotals, [0, 150, 60, 0, 45, 0, 0]);
  assert.equal(sheet.total, 255);
  assert.deepEqual(timesheet([], tasks, mon).rows, []);
});

test('hours:minutes and the CSV', () => {
  assert.equal(hm(0), '');
  assert.equal(hm(45), '0:45');
  assert.equal(hm(150), '2:30');
  const sheet = timesheet([{ task_id: 'b', start: Date.UTC(2026, 10, 16, 12), minutes: 90, logged: true }], tasks, mon);
  assert.equal(timesheetCsv(sheet),
    'Task,2026-11-16,2026-11-17,2026-11-18,2026-11-19,2026-11-20,2026-11-21,2026-11-22,Total (h)\r\n'
    + '"Report, Q4",1.5,,,,,,,1.5\r\n'
    + 'Total,1.5,,,,,,,1.5\r\n');
});
