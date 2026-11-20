// Loans, cash flows and depreciation with awkward arguments (rate 0, -1% and 100%, 0.5 and -5 periods, type 2 and 0.5,
// periods past the end): 24 functions, 12 calls each at random, worked out again by LibreOffice. The comparison found
// DDB of a part-way period (2.5) giving period 3's amount (Excel and LibreOffice decline the book value smoothly:
// 1859.03, not 1440), and RATE of a negative number of periods finding a rate instead of refusing (#NUM!).
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excelFromSheet } from '../src/office/excel.js';
import { bookEvaluator } from '../src/sheetcalc/formula.js';

// Where Excel's documentation says #NUM! and LibreOffice gives a number, Sheets does as Excel: SYD of period 0 or past
// the life, DB past the life with a full first year, EFFECT of a rate of 0 or less, NPER with nothing to pay or reach,
// and RATE where no rate settles (LibreOffice: 1.1E+14).
const EXCEL_DIFFERS = /^=SYD\(10000,1000,(10,0|5,6)\)|^=DB\(10000,1000,5,6,12\)|^=EFFECT\((0|-0\.01),|^=NPER\([^,]+,0,0,0|^=RATE\(1,250000,0,-0\.01/;

test('loans, cash flows and depreciation: the same answers as LibreOffice', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const cells = { A1: '=-1000', A2: '=300', A3: '=400', A4: '=500', A5: '=-50', A6: '=200',
    B1: '=DATE(2024,1,1)', B2: '=DATE(2024,3,1)', B3: '=DATE(2024,10,30)', B4: '=DATE(2025,2,15)', B5: '=DATE(2025,6,1)', B6: '=DATE(2026,1,1)' };
  const RATE = ['0', '0.05', '0.05/12', '-0.01', '0.1', '1', '0.0001'];
  const NPER = ['0', '1', '12', '36', '360', '0.5', '-5', '2.5'];
  const AMT = ['1000', '-1000', '0', '250000', '-0.01'];
  const TYPE = ['0', '1', '2', '0.5'];
  let seed = 17; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const T = [
    () => `=PMT(${pick(RATE)},${pick(NPER)},${pick(AMT)},${pick(AMT)},${pick(TYPE)})`, () => `=PV(${pick(RATE)},${pick(NPER)},${pick(AMT)},${pick(AMT)},${pick(TYPE)})`,
    () => `=FV(${pick(RATE)},${pick(NPER)},${pick(AMT)},${pick(AMT)},${pick(TYPE)})`, () => `=NPER(${pick(RATE)},${pick(AMT)},${pick(AMT)},${pick(AMT)},${pick(TYPE)})`,
    () => `=RATE(${pick(NPER)},${pick(AMT)},${pick(AMT)},${pick(AMT)},${pick(TYPE)})`, () => `=IPMT(${pick(RATE)},${pick(['1', '2', '12', '0', '13', '1.5'])},12,${pick(AMT)},${pick(AMT)},${pick(TYPE)})`,
    () => `=PPMT(${pick(RATE)},${pick(['1', '2', '12', '0', '13', '1.5'])},12,${pick(AMT)},${pick(AMT)},${pick(TYPE)})`, () => `=NPV(${pick(RATE)},A2:A6)`, () => `=IRR(A1:A${pick(['3', '4', '5', '6'])})`,
    () => `=XNPV(${pick(RATE)},A1:A6,B1:B6)`, () => `=XIRR(A1:A${pick(['3', '4', '6'])},B1:B${pick(['3', '4', '6'])})`, () => `=SLN(${pick(AMT)},${pick(AMT)},${pick(NPER)})`,
    () => `=SYD(10000,1000,${pick(['5', '10', '0'])},${pick(['1', '5', '6', '0', '2.5'])})`, () => `=DDB(10000,1000,5,${pick(['1', '2', '5', '6', '0', '2.5'])},${pick(['2', '1.5', '3'])})`,
    () => `=DB(10000,1000,5,${pick(['1', '2', '5', '6', '0'])},${pick(['12', '6', '7', '13'])})`, () => `=VDB(10000,1000,5,${pick(['0', '1', '2.5'])},${pick(['1', '3', '5', '6'])},2,${pick(['TRUE', 'FALSE'])})`,
    () => `=CUMIPMT(${pick(RATE)},36,10000,${pick(['1', '2', '0'])},${pick(['12', '36', '37'])},${pick(['0', '1', '2'])})`, () => `=CUMPRINC(${pick(RATE)},36,10000,${pick(['1', '2', '0'])},${pick(['12', '36', '37'])},${pick(['0', '1', '2'])})`,
    () => `=EFFECT(${pick(RATE)},${pick(['12', '1', '0', '0.5', '4.7'])})`, () => `=NOMINAL(${pick(RATE)},${pick(['12', '1', '0', '4.7'])})`, () => `=RRI(${pick(NPER)},${pick(AMT)},${pick(AMT)})`,
    () => `=PDURATION(${pick(RATE)},${pick(AMT)},${pick(AMT)})`, () => `=ISPMT(${pick(RATE)},${pick(['1', '0', '12'])},12,${pick(AMT)})`, () => `=FVSCHEDULE(1000,{0.05,0.1,-0.02})`,
  ];
  const cases = [];
  let r = 0;
  for (const t of T) for (let k = 0; k < 12; k++) { r++; cells[`H${r}`] = t(); cases.push(cells[`H${r}`]); }
  const book = { sheets: [{ name: 'S', cells }] };
  const ev = bookEvaluator(book.sheets, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finlo-'));
  fs.mkdirSync(path.join(dir, 'profile', 'user'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile', 'user', 'registrymodifications.xcu'), `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>`);
  fs.writeFileSync(path.join(dir, 'b.xlsx'), await excelFromSheet(book));
  soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):9,0,76,1,,1033,false,true,false', '--outdir', dir, path.join(dir, 'b.xlsx')]);
  const lines = fs.readFileSync(path.join(dir, 'b.csv'), 'utf8').replace(/\r/g, '').split('\n');
  fs.rmSync(dir, { recursive: true, force: true });
  // (LibreOffice shows rates as percentages: 8.9% is 0.089; numbers equal to 7 significant places, as solvers settle)
  const same = (a, b) => a === b || (/^Err:5/.test(b) && /^#/.test(a))
    || (a !== '' && b !== '' && Number.isFinite(+a) && Number.isFinite(+b) && Math.abs(+a - +b) <= 1e-7 * Math.max(1, Math.abs(+b)));
  const wrong = [];
  let compared = 0;
  cases.forEach((c, i) => {
    if (EXCEL_DIFFERS.test(c)) return;
    let ours = ev(`H${i + 1}`);
    ours = String(ours?.error ?? ours);
    let lo = lines[i].split('\t').pop();
    if (/^-?[\d.E+-]+%$/.test(lo)) lo = String(Number(lo.slice(0, -1)) / 100);
    compared++;
    if (!same(ours, lo)) wrong.push(`${c}: ${ours}, LibreOffice ${lo}`);
  });
  assert.ok(compared > 270, `compared ${compared}`);
  assert.deepEqual(wrong, []);
});

test('the fixed cases', () => {
  const ev = bookEvaluator([{ name: 'S', cells: { A1: '=DDB(10000,1000,5,2.5)', A2: '=ERROR.TYPE(RATE(-5,1000,250000))', A3: '=DDB(10000,1000,5,2)' } }], 0);
  assert.ok(Math.abs(ev('A1') - 1859.032006) < 1e-5, String(ev('A1')));
  assert.equal(ev('A2'), 6); // #NUM!
  assert.equal(ev('A3'), 2400); // (whole periods as before)
});
