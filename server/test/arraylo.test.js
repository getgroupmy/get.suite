// Arrays in formulas: SUMPRODUCT of conditions and values ((A1:A6>2)*B1:B6, --(C1:C6="red"), 1/COUNTIF(…)), MMULT,
// TRANSPOSE, MDETERM, MINVERSE and array constants, 18 kinds 12 times each at random, worked out again by LibreOffice.
// The comparison found ROW(B1:B6) (and COLUMN of several columns) giving only the first number inside a formula, so
// =SUMPRODUCT(ROW(B1:B6)*…) used 1 for every row; it gives each row's number now, as Excel does (and spills on its own).
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excelFromSheet } from '../src/office/excel.js';
import { bookEvaluator } from '../src/sheetcalc/formula.js';

// Not compared: arrays of different sizes worked together ({1,2;3,4}*{1;2;3}): Excel widens both to the larger and puts
// #N/A where the smaller has nothing (so SUMPRODUCT of it is #N/A), and Sheets does the same; LibreOffice gives a number.
const NOT_COMPARED = /TRANSPOSE\(D1:E2\)\*\{1;2;3\}|TRANSPOSE\(\{1,2,3\}\)\*\{1;2\}|\{1,2;3,4\}\*\{1;2;3\}|\{1;2;3\}\*\{1,2;3,4\}/;

test('array formulas: the same answers as LibreOffice', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const cells = { A1: '=1', A2: '=5', A3: '=3', A4: 'x', A5: '', A6: '=8', B1: '=2', B2: '=4', B3: '=6', B4: '=8', B5: '=10', B6: '=12',
    C1: 'red', C2: 'blue', C3: 'red', C4: 'Red', C5: 'green', C6: 'red', D1: '=1', D2: '=2', E1: '=3', E2: '=4' };
  let seed = 37; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const cond = () => pick(['(A1:A6>2)', '(B1:B6<=8)', '(C1:C6="red")', '(A1:A6<>"")', 'ISNUMBER(A1:A6)', '(MOD(B1:B6,4)=0)', '(LEN(C1:C6)>3)', '(LEFT(C1:C6)="r")', 'ISTEXT(A1:A6)', '(A1:A6=B1:B6/2)']);
  const vals = () => pick(['B1:B6', 'A1:A6', '1', 'B1:B6^2', '(B1:B6-1)', 'LEN(C1:C6)', 'ROW(B1:B6)']);
  const T = [
    () => `=SUMPRODUCT(${cond()}*${vals()})`, () => `=SUMPRODUCT(--${cond()})`, () => `=SUMPRODUCT(${cond()}*${cond()})`, () => `=SUMPRODUCT(${cond()}+${cond()})`,
    () => `=SUMPRODUCT(${vals()},${vals()})`.replace('SUMPRODUCT(1,', 'SUMPRODUCT(B1:B6,'), () => `=SUMPRODUCT(${vals()}*${cond()},B1:B6)`,
    () => `=SUM(MMULT(D1:E2,${pick(['D1:E2', '{1;1}', '{1,0;0,1}', 'TRANSPOSE(D1:E2)'])}))`, () => `=SUMPRODUCT(TRANSPOSE(${pick(['D1:E2', '{1,2,3}'])})*${pick(['2', '{1;2}', '{1;2;3}'])})`,
    () => `=SUMPRODUCT({1,2,3}*{4,5,6})`, () => `=SUMPRODUCT(${pick(['{1;2;3}', '{1,2;3,4}'])}*${pick(['{1;2;3}', '{1,2;3,4}', '{1,2}', '2'])})`,
    () => `=SUMPRODUCT(MAX(${cond()}*B1:B6))`, () => `=SUMPRODUCT(LARGE(${cond()}*B1:B6,${pick(['1', '2', '3'])}))`, () => `=SUMPRODUCT(1/COUNTIF(C1:C6,C1:C6))`,
    () => `=SUMPRODUCT(${cond()}*${cond()},B1:B6)`, () => `=SUMPRODUCT(ISERROR(A1:A6*1)*1)`, () => `=MDETERM(${pick(['D1:E2', '{1,2;3,4}', '{2,0,0;0,3,0;0,0,4}'])})`,
    () => `=SUMPRODUCT(MINVERSE(${pick(['D1:E2', '{1,2;3,4}', '{4,7;2,6}'])}))`, () => `=SUMPRODUCT((A1:A6>2)*(B1:B6>5)*B1:B6)`,
  ];
  const cases = [];
  let r = 0;
  for (const t of T) for (let k = 0; k < 12; k++) { r++; cells[`H${r}`] = t(); cases.push(cells[`H${r}`]); }
  const book = { sheets: [{ name: 'S', cells }] };
  const ev = bookEvaluator(book.sheets, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arraylo-'));
  fs.mkdirSync(path.join(dir, 'profile', 'user'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile', 'user', 'registrymodifications.xcu'), `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>`);
  fs.writeFileSync(path.join(dir, 'b.xlsx'), await excelFromSheet(book));
  soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):9,0,76,1,,1033,false,true,false', '--outdir', dir, path.join(dir, 'b.xlsx')]);
  const lines = fs.readFileSync(path.join(dir, 'b.csv'), 'utf8').replace(/\r/g, '').split('\n');
  fs.rmSync(dir, { recursive: true, force: true });
  const same = (a, b) => a === b || (/^Err:5/.test(b) && /^#/.test(a))
    || (a !== '' && b !== '' && Number.isFinite(+a) && Number.isFinite(+b) && Math.abs(+a - +b) <= 1e-9 * Math.max(1, Math.abs(+b)));
  const wrong = [];
  let compared = 0;
  cases.forEach((c, i) => {
    if (NOT_COMPARED.test(c)) return;
    let ours = ev(`H${i + 1}`);
    ours = String(ours?.error ?? ours);
    const lo = lines[i].split('\t').pop();
    compared++;
    if (!same(ours, lo)) wrong.push(`${c}: ${ours}, LibreOffice ${lo}`);
  });
  assert.ok(compared > 200, `compared ${compared}`);
  assert.deepEqual(wrong, []);
});

test('ROW and COLUMN of a range give every number; arrays of different sizes #N/A where one runs out', () => {
  const cells = {
    B1: '=2', B2: '=4', B3: '=6',
    A1: '=SUMPRODUCT(ROW(B1:B3)*B1:B3)', A2: '=SUM(COLUMN(B1:D1))', A3: '=ERROR.TYPE(SUMPRODUCT({1,2;3,4}*{1;2;3}))', A4: '=SUMPRODUCT({1,2;3,4}*{1;2})',
    C5: '=ROW(B1:B3)', C9: '=ROW(B4)',
  };
  const ev = bookEvaluator([{ name: 'S', cells }], 0);
  assert.deepEqual(['A1', 'A2', 'A3', 'A4', 'C5', 'C6', 'C7', 'C9'].map((k) => ev(k)), [28, 9, 7, 17, 1, 2, 3, 4]);
});
