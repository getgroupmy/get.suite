// TODAY() and NOW(): the date and time where you are (as Excel, LibreOffice and Google Sheets have them), not UTC.
// At 7:30 on Saturday morning in Kuala Lumpur it's still Friday 23:30 in UTC.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluator } from './formula.js';

test('TODAY and NOW: local date and time, not UTC', (t) => {
  const was = process.env.TZ;
  process.env.TZ = 'Asia/Kuala_Lumpur';
  t.after(() => { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; mock.timers.reset(); });
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 20, 23, 30) }); // Saturday 21 November, 7:30 there
  const e = createEvaluator({ A1: '=TODAY()', A2: '=NOW()', A3: '=WEEKDAY(TODAY())', A4: '=TEXT(NOW(),"hh:mm")', A5: '=DAY(TODAY())' });
  assert.equal(String(e('A1')), '2026-11-21');
  assert.equal(String(e('A2')), '2026-11-21 07:30');
  assert.equal(Number(e('A3')), 7, 'a Saturday');
  assert.equal(String(e('A4')), '07:30');
  assert.equal(Number(e('A5')), 21);
});
