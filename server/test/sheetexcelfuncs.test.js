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

test('and the second batch: matrices, distributions, depreciation', async () => {
  const csv = await delimitedFromSheet({ sheets: [{ name: 'Sheet1', cells: {
    A1: '=MDETERM({3,6,1;1,1,0;3,10,2})', A2: '=ROUND(F.INV.RT(0.01,6,4),2)', A3: '=VDB(2400,300,10,0,1)', A4: '=BIN2HEX(11111011,4)', A5: '=BINOM.INV(6,0.5,0.75)',
  } }] }, 0);
  assert.deepEqual(csv.trim().split(/\r?\n/), ['1', '15.21', '480', '00FB', '4']);
});

test('AGGREGATE skips the error cells in a download too', async () => {
  const csv = await delimitedFromSheet({ sheets: [{ name: 'Sheet1', cells: { A1: '5', A2: '=1/0', A3: '7', B1: '=AGGREGATE(9,6,A1:A3)' } }] }, 0);
  assert.equal(csv.trim().split(/\r?\n/)[0].split(',')[1], '12');
});

test('SUBTOTAL 109 and AGGREGATE leave out the rows a filter or Hide row hides; SUBTOTAL 9 only the filtered ones', async () => {
  const sheet = { name: 'Sheet1', cells: {
    A1: 'Team', B1: 'Hours', A2: 'Red', B2: '10', A3: 'Blue', B3: '20', A4: 'Red', B4: '30', A5: 'Blue', B5: '40',
    D1: '=SUBTOTAL(109,B2:B5)', D2: '=SUBTOTAL(9,B2:B5)', D3: '=AGGREGATE(9,5,B2:B5)', D4: '=SUM(B2:B5)',
  }, filter: { range: 'A1:B5', hidden: { A: ['Blue'] } }, hide: { rows: [3] } }; // Blue rows filtered out, row 4 (Red, 30) hidden by hand
  const csv = await delimitedFromSheet({ sheets: [sheet] }, 0);
  const col = csv.trim().split(/\r?\n/).map((l) => l.split(',')[3]);
  assert.deepEqual(col.slice(0, 4), ['10', '40', '10', '100'], 'filtered and hidden: 10; filtered only: 10+30; AGGREGATE 5: 10; SUM: all');
});
