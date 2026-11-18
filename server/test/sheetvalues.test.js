import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { excelFromSheet } from '../src/office/excel.js';
import { odsFromSheet, sheetFromOds } from '../src/office/ods.js';
import { delimitedFromSheet, formulaResults, sheetReadingText } from '../src/office/sheetvalues.js';

const data = { sheets: [
  { name: 'S', cells: { A1: '2', A2: '3', A3: '=A1*A2', A4: '=A3>5', A5: '=1/0', A6: '=UPPER("hi")&" "&B1', B1: 'there', A7: '=Other!A1+1', A8: '=TODAY()', C1: '0.25', C2: '=C1*2' }, formats: { A8: { num: 'date' }, C2: { num: 'percent' } } },
  { name: 'Other', cells: { A1: '41' } },
] };

test('formula results: worked out with the Sheets engine (other sheets too); dates left out', () => {
  const r = formulaResults(data, 0);
  assert.deepEqual(['A3', 'A4', 'A5', 'A6', 'A7', 'B1'].map(r), [{ number: 6 }, { bool: true }, { error: '#DIV/0!' }, { text: 'HI there' }, { number: 42 }, { text: 'there' }]);
});

test('Excel downloads carry each formula\'s result, so previews that don\'t calculate show it', async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await excelFromSheet(data));
  const ws = wb.getWorksheet('S');
  assert.deepEqual(['A3', 'A4', 'A5', 'A6', 'A7', 'C2'].map((k) => ws.getCell(k).value), [
    { formula: 'A1*A2', result: 6 }, { formula: 'A3>5', result: true }, { formula: '1/0', result: { error: '#DIV/0!' } },
    { formula: 'UPPER("hi")&" "&B1', result: 'HI there' }, { formula: 'Other!A1+1', result: 42 }, { formula: 'C1*2', result: 0.5 },
  ]);
  assert.equal(ws.getCell('A8').value.result, undefined, 'a date formula is left for Excel to work out');
});

test('.ods downloads carry each formula\'s value, and still open with the formulas', async () => {
  const buf = await odsFromSheet(data);
  const xml = await (await JSZip.loadAsync(buf)).file('content.xml').async('string');
  const cell = (f) => new RegExp(`<table:table-cell [^>]*table:formula="of:=${f}"[^>]*>(<text:p>[^<]*</text:p>)?`).exec(xml)?.[0]; // (a styled cell has its style first)
  assert.match(cell('\\[\\.A1\\]\\*\\[\\.A2\\]'), /office:value-type="float" office:value="6"><text:p>6<\/text:p>/);
  assert.match(cell('\\[\\.A3\\]&gt;5'), /office:value-type="boolean" office:boolean-value="true"><text:p>TRUE/);
  assert.match(cell('1/0'), /office:value-type="string"><text:p>#DIV\/0!/);
  assert.match(cell('\\[\\.C1\\]\\*2'), /office:value-type="percentage" office:value="0.5"/);
  const back = await sheetFromOds(buf);
  assert.equal(back.sheets[0].cells.A3, '=A1*A2');
  assert.equal(back.sheets[0].cells.A7, '=Other!A1+1');
});

test('a sheet as CSV or TSV: the values the page shows, quoted where needed', async () => {
  const d = { sheets: [{ name: 'T', cells: { A1: 'Name', B1: 'Note', A2: 'Ana', B2: 'says "hi", twice', A3: 'Sum', B3: '=2+3', C3: '=1/0', B4: '1500.5' }, formats: { B4: { num: 'currency', cur: 'USD' } } }] };
  assert.equal(await delimitedFromSheet(d, 0), 'Name,Note,\r\nAna,"says ""hi"", twice",\r\nSum,5,#DIV/0!\r\n,"$1,500.50",\r\n');
  assert.equal(await delimitedFromSheet(d, 0, '\t'), 'Name\tNote\t\r\nAna\tsays "hi", twice\t\r\nSum\t5\t#DIV/0!\r\n\t$1,500.50\t\r\n');
  assert.equal(await delimitedFromSheet({ sheets: [] }, 0), '');
});

test('a spreadsheet as reading text: a table of values a sheet, then its formulas and what they give', async () => {
  const text = await sheetReadingText({ sheets: [
    { name: 'Budget', cells: { A1: 'Item', B1: 'Cost', A2: 'Rent', B2: '900', A3: 'Staff', B3: '2400', A5: 'Total', B5: '=SUM(B2:B3)' }, formats: { B5: { num: 'currency', cur: 'USD' } } },
    { name: 'Notes', hidden: true, cells: {} },
  ] });
  assert.equal(text, '## Sheet: Budget\n\tA\tB\n1\tItem\tCost\n2\tRent\t900\n3\tStaff\t2400\n5\tTotal\t$3,300.00\n\nFormulas:\nB5: =SUM(B2:B3) → 3300\n\n## Sheet: Notes (hidden)\n(empty)');
});
