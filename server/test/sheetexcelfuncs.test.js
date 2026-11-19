// The server works formulas out too (CSV and Excel downloads, PDFs, reading a sheet aloud): array constants and the
// functions Excel files use come out as values there, not #NAME? or #ERROR!.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delimitedFromSheet } from '../src/office/sheetvalues.js';

test('a CSV download has the worked-out values', async () => {
  const csv = await delimitedFromSheet({ sheets: [{ name: 'Sheet1', cells: {
    A1: '=SUM({1,2;3,4})', A2: '=ROUND(DEGREES(ATAN2(1,1)),0)', A3: '=ISNA(NA())', A4: '=LOOKUP(75,{0,60,90},{"C","B","A"})', A5: '=REPLACE("2026-11",5,1,"/")',
  } }] }, 0);
  assert.deepEqual(csv.trim().split(/\r?\n/), ['10', '45', 'TRUE', 'B', '2026/11']);
});
