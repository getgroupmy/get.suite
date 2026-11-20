// A book's structure through files: tab colours, a hidden sheet, dropdowns and tick boxes, a filter, grouped rows, every
// kind of conditional format, and a table come back the same from our .xlsx and .ods and after LibreOffice saves them.
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excelFromSheet, sheetFromExcel } from '../src/office/excel.js';
import { odsFromSheet, sheetFromOds } from '../src/office/ods.js';

const RULES = [['between', { value: '3', value2: '8' }], ['eq', { value: '10' }], ['contains', { value: 'a' }], ['notContains', { value: 'z' }], ['starts', { value: 'T' }],
  ['ends', { value: 'e' }], ['duplicate', {}], ['unique', {}], ['top', { value: '2' }], ['bottom', { value: '1' }], ['aboveAvg', {}], ['belowAvg', {}], ['empty', {}], ['notEmpty', {}],
  ['error', {}], ['formula', { value: '=D2>5' }], ['dateToday', {}], ['datePast7', {}], ['dateThisMonth', {}]];
const book = () => ({ sheets: [
  { name: 'Data', tabColor: '#ff9900', cells: { A1: 'Item', B1: 'Status', C1: 'Done', D1: 'Qty', A2: 'Tea', B2: 'Open', D2: '10', A3: 'Cake', B3: 'Done', C3: 'TRUE', D3: '4', A4: 'Pie', B4: 'Open', D4: '7', A5: 'Jam', B5: 'Done', D5: '2' },
    validations: [{ id: 'v1', range: 'B2:B9', type: 'list', values: ['Open', 'Done'], strict: true }, { id: 'v2', range: 'C2:C9', type: 'checkbox' }],
    filter: { range: 'A1:D5', hidden: {} }, groups: [{ axis: 'row', from: 1, to: 2, collapsed: false }],
    rules: [{ id: 'r1', range: 'D2:D5', when: 'scale', scale: ['#ffffff', '#57bb8a'] }, { id: 'r2', range: 'D2:D5', when: 'bars', bar: '#638ec6' },
      ...RULES.map(([when, x], i) => ({ id: `q${i}`, range: 'E2:E5', when, ...x, fill: '#fce8b2' }))] },
  { name: 'Hidden', hidden: true, cells: { A1: 'secret' } },
  { name: 'Table', cells: { A1: 'Name', B1: 'Score', A2: 'Ann', B2: '5', A3: 'Bo', B3: '7' }, bands: [{ id: 'b', range: 'A1:B3', name: 'Scores', header: true, head: '#4a86e8', odd: '#ffffff', even: '#e8f0fe' }] },
] });
const shape = (b, ext) => b.sheets.map((s) => ({ name: s.name, tabColor: s.tabColor, hidden: s.hidden, validations: (s.validations || []).map(({ id, ...v }) => v), filter: s.filter, groups: s.groups,
  rules: (s.rules || []).map(({ id, ...r }) => r),
  // (.ods has no table styles LibreOffice reads: a table's colours go as the cells' own, and come back so)
  ...(ext === 'xlsx' && { bands: (s.bands || []).map((x) => ({ range: x.range, name: x.name, header: x.header, head: x.head, odd: x.odd, even: x.even })) }) }));

for (const [ext, write, read] of [['xlsx', excelFromSheet, sheetFromExcel], ['ods', odsFromSheet, sheetFromOds]]) {
  test(`.${ext}: the book's structure comes back the same (conditional formats of every kind, "ends with" too)`, async () => {
    assert.deepEqual(shape(await read(await write(book())), ext), shape(book(), ext));
  });
}

for (const [ext, write, read] of [['xlsx', excelFromSheet, sheetFromExcel], ['ods', odsFromSheet, sheetFromOds]]) {
  test(`through LibreOffice (.${ext}): saved again by it, the structure comes back the same (the filter too)`, { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'structrt-'));
    fs.writeFileSync(path.join(dir, `in.${ext}`), await write(book()));
    soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', ext, '--outdir', path.join(dir, 'out'), path.join(dir, `in.${ext}`)]);
    assert.deepEqual(shape(await read(fs.readFileSync(path.join(dir, 'out', `in.${ext}`))), ext), shape(book(), ext));
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('.xlsx: a named function using $A$1 makes a file that opens (it used to come out broken)', async () => {
  const buf = await excelFromSheet({ sheets: [{ name: 'S', cells: { A1: '2' } }], functions: [{ name: 'TAXED', params: ['x'], body: '=x*$A$1' }] });
  assert.deepEqual((await sheetFromExcel(buf)).functions, [{ name: 'TAXED', params: ['x'], body: 'x*$A$1' }]);
});
