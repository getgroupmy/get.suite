// Date and time functions with awkward arguments (29 February, month ends, -0.5 and 1.9 months, every WEEKDAY and WEEKNUM
// type, years 0, 100 and 10000, spans across a century, times past midnight), worked out again by LibreOffice: 20 kinds
// of call, 18 each at random. The comparison found WEEKDAY and WEEKNUM types 12–17 and 21 giving type 1's answer,
// EDATE and EOMONTH of -0.5 months going back a month, DATE(100, 1, 1) not 1 Jan 2000, NETWORKDAYS refusing more than 100
// years, and NETWORKDAYS.INTL and WORKDAY.INTL written into .xlsx files with a prefix LibreOffice can't read (#NAME?).
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excelFromSheet } from '../src/office/excel.js';
import { bookEvaluator } from '../src/sheetcalc/formula.js';

// Where Excel and LibreOffice part ways, Sheets does as Excel: WEEKNUM counts on to week 53 at a year's end (LibreOffice
// starts week 1), YEARFRAC's US 30/360 takes 29 February as the 30th, DAYS ignores times of day, DATE takes years
// 0–1899 from 1900 and refuses 10000, a fraction of a working day is dropped (towards 0), and HOUR, MINUTE and SECOND
// round to the second (LibreOffice cuts the fraction off). Sheets' day numbers before 1 March 1900 are one less than
// Excel's (Excel counts a 29 February 1900 that never was).
const EXCEL_DIFFERS = /WEEKNUM\(DATE\((2020,12,27|2025,12,31)\)|YEARFRAC\(.*DATE\(2024,2,29\).*,0\)|^=\(DAYS\(45000\.75|^=\(DATE\((0|99|100|10000|-1),|INTL\(.*,-0\.5,|^=\(HOUR\(|^=\(MINUTE\(|DATE\(1900,3,1\)/;

test('date and time functions with awkward arguments: the same answers as LibreOffice', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const D = ['DATE(2024,2,29)', 'DATE(2023,1,31)', 'DATE(2026,11,20)', 'DATE(2025,12,31)', 'DATE(2024,3,31)', 'DATE(2000,2,28)', 'DATE(1900,3,1)', 'DATE(2026,1,1)', 'DATE(2027,6,15)', 'DATE(2024,8,31)', '45000.75', 'DATE(2021,1,3)', 'DATE(2020,12,27)'];
  const K = ['0', '1', '-1', '2', '3', '11', '12', '13', '17', '21', '-13', '1.9', '-0.5', '24', '4', '14', '15', '16'];
  let seed = 5; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const T = [
    () => `=EDATE(${pick(D)},${pick(K)})`, () => `=EOMONTH(${pick(D)},${pick(K)})`, () => `=DATEDIF(${pick(D)},${pick(D)},"${pick(['Y', 'M', 'D', 'YM', 'MD', 'YD'])}")`,
    () => `=WEEKDAY(${pick(D)},${pick(['1', '2', '3', '11', '12', '13', '14', '15', '16', '17', '0', '4'])})`, () => `=WEEKNUM(${pick(D)},${pick(['1', '2', '11', '12', '13', '14', '15', '16', '17', '21', '3'])})`,
    () => `=ISOWEEKNUM(${pick(D)})`, () => `=YEARFRAC(${pick(D)},${pick(D)},${pick(['0', '1', '2', '3', '4'])})`, () => `=DAYS360(${pick(D)},${pick(D)})`, () => `=DAYS360(${pick(D)},${pick(D)},TRUE)`,
    () => `=NETWORKDAYS(${pick(D)},${pick(D)})`, () => `=WORKDAY(${pick(D)},${pick(K)})`, () => `=DATE(2024,${pick(K)},${pick(K)})`, () => `=DAYS(${pick(D)},${pick(D)})`,
    () => `=YEAR(${pick(D)})+MONTH(${pick(D)})/100`, () => `=DATE(${pick(['0', '99', '100', '1899', '1900', '10000', '-1', '2024.7'])},1,1)`, () => `=TIME(${pick(K)},${pick(K)},${pick(K)})`,
    () => `=NETWORKDAYS.INTL(${pick(D)},${pick(D)},${pick(['1', '2', '7', '11', '17', '"0000011"', '"1000001"'])})`, () => `=WORKDAY.INTL(${pick(D)},${pick(K)},${pick(['1', '7', '11', '"0010000"'])})`,
    () => `=HOUR(${pick(['0.75', '45000.999', '-0.25', '1.5', '0.99999999'])})`, () => `=MINUTE(${pick(['0.75', '45000.999', '0.0006944', '0.99999999', '0.5007'])})`,
  ];
  const cells = {}, cases = [];
  let r = 0;
  for (const t of T) for (let k = 0; k < 18; k++) { r++; cells[`H${r}`] = `=(${t().slice(1)})*1`; cases.push(cells[`H${r}`]); }
  const book = { sheets: [{ name: 'S', cells }] };
  const ev = bookEvaluator(book.sheets, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'datelo-'));
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
    if (EXCEL_DIFFERS.test(c)) return;
    let ours = ev(`H${i + 1}`);
    ours = typeof ours === 'boolean' ? String(ours).toUpperCase() : String(ours?.error ?? ours);
    const lo = lines[i].split('\t').pop();
    compared++;
    if (!same(ours, lo)) wrong.push(`${c}: ${ours}, LibreOffice ${lo}`);
  });
  assert.ok(compared > 250, `compared ${compared}`);
  assert.deepEqual(wrong, []);
});

test('the fixed cases, and Excel’s answers where LibreOffice’s differ', () => {
  const cells = {
    A1: '=WEEKDAY(DATE(2024,8,31),14)', A2: '=WEEKDAY(DATE(2024,2,29),15)', A3: '=IFERROR(WEEKDAY(DATE(2024,2,29),4),"no")', A4: '=WEEKNUM(DATE(2024,2,29),14)',
    A5: '=WEEKNUM(DATE(2024,3,31),21)', A6: '=IFERROR(WEEKNUM(DATE(2024,3,31),3),"no")', A7: '=EDATE(DATE(2025,12,31),-0.5)', A8: '=EOMONTH(DATE(2021,1,3),-0.5)',
    A9: '=DATE(100,1,1)', A10: '=IFERROR(DATE(10000,1,1),"no")', A11: '=NETWORKDAYS(DATE(1900,3,1),DATE(2026,1,1))', A12: '=NETWORKDAYS(DATE(2026,11,2),DATE(2026,11,20),DATE(2026,11,11))',
    A13: '=WEEKNUM(DATE(2025,12,31),2)', A14: '=NETWORKDAYS.INTL(DATE(1900,3,5),DATE(2026,1,1),11)',
  };
  const ev = bookEvaluator([{ name: 'S', cells }], 0);
  const got = Object.keys(cells).map((k) => { const v = ev(k); return v?.error ?? v; });
  assert.deepEqual(got, [3, 7, 'no', 10, 13, 'no', '2025-12-31', '2021-01-31', '2000-01-01', 'no', 32831, 14, 53, 39394]);
});
