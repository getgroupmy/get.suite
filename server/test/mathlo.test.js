// Maths and conversion functions with awkward arguments (halves, negatives, fractions where whole numbers are wanted,
// 1E+15, 1E-10, 0.1+0.2), worked out again by LibreOffice: 30 two-argument functions 14 times each and 37 one-argument
// functions 6 times each, at random. The comparison found ROUNDUP, ROUNDDOWN and TRUNC taking a fractional number of
// digits as a power of ten (=ROUNDUP(2.5, -0.5) was 3.16…, now 3), ROUNDUP(1E-10, 1) giving 0 (now 0.1), CEILING and
// FLOOR of a positive number by a negative step not refused, GCD, LCM, COMBIN and FACT taking -0.5 as 0, DEC2BIN of a
// negative number refusing a places argument Excel ignores, and CHAR(1.005) stopping the sheet.
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excelFromSheet } from '../src/office/excel.js';
import { bookEvaluator } from '../src/sheetcalc/formula.js';

const X = ['2.5', '-2.5', '1.005', '-1.005', '0.125', '1234.5678', '-1234.5678', '7', '-7', '0', '0.5', '-0.5', '2.675', '1E+15', '3.14159', '-0.001', '15', '-15', '1E-10', '0.1+0.2'];
const N = ['0', '1', '2', '-1', '-2', '3', '0.5', '-0.5', '5', '-5', '10', '0.1'];
const F2 = ['ROUND', 'ROUNDUP', 'ROUNDDOWN', 'MROUND', 'CEILING', 'FLOOR', 'CEILING.MATH', 'FLOOR.MATH', 'TRUNC', 'MOD', 'QUOTIENT', 'POWER', 'LOG', 'ATAN2',
  'CEILING.PRECISE', 'FLOOR.PRECISE', 'ISO.CEILING', 'COMBIN', 'PERMUT', 'GCD', 'LCM', 'BASE', 'DECIMAL', 'FIXED', 'DOLLAR', 'BITAND', 'BITLSHIFT', 'DEC2BIN', 'DEC2HEX', 'COMPLEX'];
const F1 = ['INT', 'EVEN', 'ODD', 'SIGN', 'ABS', 'SQRT', 'LN', 'LOG10', 'EXP', 'FACT', 'FACTDOUBLE', 'ROMAN', 'ARABIC', 'SINH', 'ACOSH', 'ATANH', 'GAMMALN', 'GAMMA',
  'ERF', 'ERFC', 'DEC2BIN', 'DEC2OCT', 'DEC2HEX', 'HEX2DEC', 'SQRTPI', 'COT', 'ACOT', 'CSC', 'SEC', 'TRUNC', 'ROUND', 'N', 'T', 'VALUE', 'CHAR', 'UNICHAR', 'LEN'];
// Where Excel and LibreOffice part ways, Sheets does as Excel: the bit functions want whole numbers (#NUM!), CHAR and
// UNICHAR of less than 1 are #VALUE!, COT(0) is #DIV/0!, DEC2HEX drops a negative number's fraction towards 0 (LibreOffice
// rounds down) and ignores places for it, DOLLAR writes a negative amount in brackets, MROUND of a number and a step of
// different signs is #NUM!, and COMPLEX writes 1E+15 out in full.
const EXCEL_DIFFERS = /^=(BITAND|BITLSHIFT|COMPLEX)\(|^=(CHAR|UNICHAR)\((0\.|1E-)|^=COT\(0\)|^=DEC2(BIN|HEX)\(-|^=DOLLAR\(-|^=MROUND\(/;

test('maths functions with awkward arguments: the same answers as LibreOffice', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const cells = {}, cases = [];
  let r = 0;
  for (const f of F2) for (let k = 0; k < 14; k++) { r++; cells[`H${r}`] = `=${f}(${pick(X)},${pick(N)})`; cases.push(cells[`H${r}`]); }
  for (const f of F1) for (let k = 0; k < 6; k++) { r++; cells[`H${r}`] = `=${f}(${pick(X)})`; cases.push(cells[`H${r}`]); }
  const book = { sheets: [{ name: 'S', cells }] };
  const ev = bookEvaluator(book.sheets, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mathlo-'));
  fs.mkdirSync(path.join(dir, 'profile', 'user'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile', 'user', 'registrymodifications.xcu'), `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>`);
  fs.writeFileSync(path.join(dir, 'b.xlsx'), await excelFromSheet(book));
  soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):9,0,76,1,,1033,false,true,false', '--outdir', dir, path.join(dir, 'b.xlsx')]);
  const lines = fs.readFileSync(path.join(dir, 'b.csv'), 'utf8').replace(/\r/g, '').split('\n');
  fs.rmSync(dir, { recursive: true, force: true });
  // LibreOffice's Err:502 (invalid argument) is Excel's #NUM! or #VALUE!; numbers equal to 9 significant places
  const same = (a, b) => a === b || (/^Err:5/.test(b) && /^#/.test(a))
    || (a !== '' && b !== '' && Number.isFinite(+a) && Number.isFinite(+b) && Math.abs(+a - +b) <= 1e-9 * Math.max(1, Math.abs(+b)));
  const wrong = [];
  let compared = 0;
  cases.forEach((c, i) => {
    let ours = ev(`H${i + 1}`);
    ours = typeof ours === 'boolean' ? String(ours).toUpperCase() : String(ours?.error ?? ours);
    if (EXCEL_DIFFERS.test(c)) return;
    compared++;
    if (!same(ours, lines[i].split('\t').pop())) wrong.push(`${c}: ${ours}, LibreOffice ${lines[i].split('\t').pop()}`);
  });
  assert.ok(compared > 540, `compared ${compared}`);
  assert.deepEqual(wrong, []);
});

test('Excel’s answers where LibreOffice’s differ, and the fixed cases', () => {
  const cells = {
    A1: '=ROUNDUP(2.5,-0.5)', A2: '=ROUNDUP(1E-10,1)', A3: '=ROUNDDOWN(3.14159,-0.5)', A4: '=TRUNC(7,0.5)', A5: '=CEILING(2.5,-1)',
    A6: '=FLOOR(1.005,-1)', A7: '=GCD(12,-0.5)', A8: '=FACT(-0.001)', A9: '=DEC2BIN(-7,3)', A10: '=CHAR(65.9)', A11: '=CEILING(-2.5,-2)',
    A12: '=ROUNDUP(0.1+0.2,1)', A13: '=DEC2BIN(-7,-1)', A14: '=DEC2HEX(-1234.5678)', A15: '=MROUND(-7,1)', A16: '=COT(0)',
  };
  const ev = bookEvaluator([{ name: 'S', cells }], 0);
  const got = Object.keys(cells).map((k) => { const v = ev(k); return v?.error ?? v; });
  assert.deepEqual(got, [3, 0.1, 3, 7, '#NUM!', '#NUM!', '#NUM!', '#NUM!', '1111111001', 'A', -4, 0.3, '#NUM!', 'FFFFFFFB2E', '#NUM!', '#DIV/0!']);
});
