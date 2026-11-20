// Text functions with awkward arguments (counts of 1.9 and -1, starts of 0, the 0th match, ß and İ, "(5)", "14:30",
// "2026-11-20", wildcards), worked out again by LibreOffice: 26 kinds of call, 18 each at random. The comparison found
// LEFT, RIGHT and MID rounding a count of 1.9 up (Excel drops the fraction) and taking -1 instead of refusing it, SEARCH
// from 0 and SUBSTITUTE of the 0th match not refused, PROPER("İstanbul") giving İStanbul, "(5)", "2:30 PM" and
// "2026-11-20" not read as numbers by + and VALUE, and COUNTIF(range, "*") counting empty cells.
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excelFromSheet } from '../src/office/excel.js';
import { bookEvaluator } from '../src/sheetcalc/formula.js';

// Where Excel and LibreOffice part ways, Sheets does as Excel: FIND and SEARCH of "" give the start, UPPER leaves ß, "5-"
// isn't a number, --"TRUE" is #VALUE!, NUMBERVALUE("") is 0, and DATEVALUE reads only dates; "" + 0 and a date's text
// plus 0 are left as Sheets has them (0, and the date itself, shown as a date).
const EXCEL_DIFFERS = /^=(FIND|SEARCH)\(""|^=UPPER\("Straße"|"5-"|^=--"TRUE"|^=NUMBERVALUE\(""\)|^=DATEVALUE\(|^=(--)?""(\+0)?$|"2026-11-20"\+0|^=--""$/;

test('text functions with awkward arguments: the same answers as LibreOffice', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const S = ['"Hello World"', '"hello world"', '""', '" a  b "', '"a*b?c"', '"x~y"', '"Straße"', '"İstanbul"', '"o\'neil-smith"', '"3.5"', '" 12 "', '"1,234"', '"$5"', '"50%"', '"1e3"', '"2026-11-20"', '"20 Nov 2026"', '"11/20/2026"', '"14:30"', '"2:30 PM"', '"TRUE"', '"abcabcabc"', '"émile zola"', '"MIXed CASE"', '"(5)"', '"-7"', '".5"', '"5-"', '"1 1/2"', '"#N/A"'];
  const IDX = ['0', '1', '2', '3', '-1', '5', '100', '1.9', '2.5'];
  const SUB = ['"a"', '"b"', '"o"', '"l"', '"*"', '"?"', '"~*"', '"a*c"', '"b?c"', '""', '"abc"', '"World"', '" "', '"ß"', '"ss"'];
  let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const T = [
    () => `=MID(${pick(S)},${pick(IDX)},${pick(IDX)})`, () => `=LEFT(${pick(S)},${pick(IDX)})`, () => `=RIGHT(${pick(S)},${pick(IDX)})`,
    () => `=FIND(${pick(SUB)},${pick(S)},${pick(IDX)})`, () => `=SEARCH(${pick(SUB)},${pick(S)})`, () => `=SEARCH(${pick(SUB)},${pick(S)},${pick(IDX)})`,
    () => `=SUBSTITUTE(${pick(S)},${pick(SUB)},${pick(SUB)})`, () => `=SUBSTITUTE(${pick(S)},${pick(SUB)},"#",${pick(IDX)})`,
    () => `=REPLACE(${pick(S)},${pick(IDX)},${pick(IDX)},"X")`, () => `=PROPER(${pick(S)})`, () => `=UPPER(${pick(S)})`, () => `=LOWER(${pick(S)})`,
    () => `=VALUE(${pick(S)})`, () => `=DATEVALUE(${pick(S)})`, () => `=TIMEVALUE(${pick(S)})`, () => `=LEN(${pick(S)})`, () => `=TRIM(${pick(S)})`,
    () => `=REPT(${pick(S)},${pick(IDX)})`, () => `=EXACT(${pick(S)},${pick(S)})`, () => `=CODE(${pick(S)})`, () => `=${pick(S)}+0`, () => `=--${pick(S)}`,
    () => `=COUNTIF(A1:A6,${pick(SUB)})`, () => `=MATCH(${pick(SUB)},A1:A6,0)`, () => `=NUMBERVALUE(${pick(S)})`, () => `=CLEAN(${pick(S)})`,
  ];
  const cells = { A1: 'abc', A2: 'a*c', A3: 'b', A4: 'ABC', A5: 'xbcx', A6: '' }, cases = [];
  let r = 0;
  for (const t of T) for (let k = 0; k < 18; k++) { r++; cells[`H${r}`] = t(); cases.push(cells[`H${r}`]); }
  const book = { sheets: [{ name: 'S', cells }] };
  const ev = bookEvaluator(book.sheets, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textfnlo-'));
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
  assert.ok(compared > 420, `compared ${compared}`);
  assert.deepEqual(wrong, []);
});

test('the fixed cases, and Excel’s answers where LibreOffice’s differ', () => {
  const cells = {
    B1: 'abc', B2: '', B3: '=12', B4: 'b',
    A1: '=LEFT("Hello",1.9)', A2: '=IFERROR(LEFT("Hello",-1),"no")', A3: '=MID("Hello",1.9,2.5)', A4: '=IFERROR(SEARCH("l","Hello",0),"no")',
    A5: '=IFERROR(SUBSTITUTE("aaa","a","b",0),"no")', A6: '=PROPER("İstanbul")', A7: '="(5)"+0', A8: '=VALUE("2:30 PM")', A9: '=VALUE("2026-11-20")',
    A10: '=COUNTIF(B1:B4,"*")', A11: '=FIND("","abc",2)', A12: '=UPPER("Straße")', A13: '=IFERROR(--"TRUE","no")', A14: '=COUNTIF(B1:B4,"1*")',
  };
  const ev = bookEvaluator([{ name: 'S', cells }], 0);
  const got = Object.keys(cells).filter((k) => k[0] === 'A').map((k) => { const v = ev(k); return v?.error ?? v; });
  assert.deepEqual(got, ['H', 'no', 'He', 'no', 'no', 'İstanbul', -5, 0.6041666666666666, 46346, 2, 2, 'STRAßE', 'no', 0]);
});
