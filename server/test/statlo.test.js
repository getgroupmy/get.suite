// Statistics over ranges with text, an empty cell, a number written as text ("5") and negatives among the numbers:
// 54 kinds of call (spread, middle, percentiles, quartiles, ranks, skew, trimmed mean, correlation, LARGE, SMALL), 6 each
// at random, worked out again by LibreOffice. The comparison found LARGE and SMALL with a k of 1.5 giving nothing at all
// (shown as "undefined"), and MODE of a range with several values seen equally often giving the one whose repeat came
// first, not the first in the range.
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excelFromSheet } from '../src/office/excel.js';
import { bookEvaluator } from '../src/sheetcalc/formula.js';

// Not compared: MODE where several values tie (Sheets gives the first in the range, as Excel's MODE.MULT lists them;
// LibreOffice another), MODE.MULT and FREQUENCY (they spill into the cells below, here taken: #SPILL!), and LARGE and
// SMALL of a fractional k (Sheets drops the fraction; LibreOffice rounds LARGE's up). Where an answer can't be had,
// LibreOffice's error is sometimes another (#VALUE! for Excel's #NUM! and #N/A): any error matches any. PERCENTRANK
// cuts its answer to the places asked for (3 unless given) as Excel does (0.777); LibreOffice rounds (0.778).
const NOT_COMPARED = /^=MODE\(A1:(A10|B10)\)|MODE.SNGL\(A1:(A10|B10)\)|MODE\.MULT|FREQUENCY|^=(LARGE|SMALL)\([^,]+,\d+\.\d\)/;

test('statistics with text and empty cells in the range: the same answers as LibreOffice', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const cells = {
    A1: '=3', A2: '=1', A3: '=4', A4: '=1', A5: '=5', A6: '=9', A7: '=2', A8: '=6', A9: '=5', A10: '=3',
    B1: '=2', B2: 'x', B3: 'yes', B4: '', B5: '=7', B6: '="5"', B7: '=-3', B8: 'no', B9: '=2.5', B10: '=0',
    C1: '=10', C2: '=20', C3: '=20', C4: '=30', C5: '=40', C6: '=40', C7: '=40', C8: '=50', C9: '=60', C10: '=1000',
  };
  const R = ['A1:A10', 'B1:B10', 'C1:C10', 'A1:B10', 'A1:A3'];
  const K = ['0', '0.25', '0.5', '0.9', '1', '1.5', '-0.1', '0.1', '0.33'];
  let seed = 13; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const F1 = ['STDEV', 'STDEV.S', 'STDEV.P', 'STDEVA', 'STDEVPA', 'VAR', 'VAR.P', 'VARA', 'VARPA', 'MEDIAN', 'AVERAGE', 'AVERAGEA', 'MODE', 'MODE.SNGL', 'SKEW', 'SKEW.P', 'KURT', 'DEVSQ', 'AVEDEV', 'GEOMEAN', 'HARMEAN', 'COUNT', 'COUNTA', 'COUNTBLANK', 'MAX', 'MIN', 'MAXA', 'MINA', 'SUMSQ', 'PRODUCT'];
  const T = [
    ...F1.map((f) => () => `=${f}(${pick(R)})`),
    () => `=PERCENTILE(${pick(R)},${pick(K)})`, () => `=PERCENTILE.EXC(${pick(R)},${pick(K)})`, () => `=PERCENTILE.INC(${pick(R)},${pick(K)})`,
    () => `=QUARTILE(${pick(R)},${pick(['0', '1', '2', '3', '4', '5', '1.5'])})`, () => `=QUARTILE.EXC(${pick(R)},${pick(['0', '1', '2', '3', '4'])})`,
    () => `=LARGE(${pick(R)},${pick(['1', '2', '3', '10', '11', '0', '1.5'])})`, () => `=SMALL(${pick(R)},${pick(['1', '2', '3', '10', '11', '0', '2.5'])})`,
    () => `=RANK(${pick(['1', '3', '5', '40', '7', '2.5'])},${pick(R)},${pick(['0', '1'])})`, () => `=RANK.AVG(${pick(['1', '3', '5', '40'])},${pick(R)},${pick(['0', '1'])})`,
    () => `=PERCENTRANK(${pick(R)},${pick(['1', '3', '4.5', '40', '0', '1000'])})`, () => `=PERCENTRANK.EXC(${pick(R)},${pick(['1', '3', '4.5', '40'])})`, () => `=PERCENTRANK.INC(${pick(R)},${pick(['1', '3', '4.5', '40'])},${pick(['1', '2', '3'])})`,
    () => `=CORREL(A1:A10,${pick(['B1:B10', 'C1:C10'])})`, () => `=TRIMMEAN(${pick(R)},${pick(['0', '0.2', '0.5', '1', '0.1'])})`, () => `=STANDARDIZE(${pick(['1', '5'])},${pick(['3', '0'])},${pick(['2', '0', '-1'])})`,
    () => `=FORECAST(${pick(['4', '11'])},C1:C10,A1:A10)`, () => `=SLOPE(${pick(['B1:B10', 'C1:C10'])},A1:A10)`, () => `=PEARSON(A1:A10,C1:C10)`, () => `=COVAR(A1:A10,${pick(['B1:B10', 'C1:C10'])})`,
    () => `=AVERAGEIF(${pick(R)},${pick(['">2"', '"<>3"', '"x"', '">=0"'])})`, () => `=FREQUENCY(A1:A10,{2,4})`, () => `=MODE.MULT(A1:A10)`,
  ];
  const cases = [];
  let r = 0;
  for (const t of T) for (let k = 0; k < 6; k++) { r++; cells[`H${r}`] = t(); cases.push(cells[`H${r}`]); }
  const book = { sheets: [{ name: 'S', cells }] };
  const ev = bookEvaluator(book.sheets, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statlo-'));
  fs.mkdirSync(path.join(dir, 'profile', 'user'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile', 'user', 'registrymodifications.xcu'), `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>`);
  fs.writeFileSync(path.join(dir, 'b.xlsx'), await excelFromSheet(book));
  soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):9,0,76,1,,1033,false,true,false', '--outdir', dir, path.join(dir, 'b.xlsx')]);
  const lines = fs.readFileSync(path.join(dir, 'b.csv'), 'utf8').replace(/\r/g, '').split('\n');
  fs.rmSync(dir, { recursive: true, force: true });
  const same = (c, a, b) => a === b || (/^#|^Err:/.test(a) && /^#|^Err:/.test(b))
    || (a !== '' && b !== '' && Number.isFinite(+a) && Number.isFinite(+b)
      && Math.abs(+a - +b) <= (/PERCENTRANK/.test(c) ? 0.011 : 1e-9 * Math.max(1, Math.abs(+b))));
  const wrong = [];
  let compared = 0;
  cases.forEach((c, i) => {
    if (NOT_COMPARED.test(c)) return;
    let ours = ev(`H${i + 1}`);
    ours = String(ours?.error ?? ours);
    const lo = lines[i].split('\t').pop();
    compared++;
    if (!same(c, ours, lo)) wrong.push(`${c}: ${ours}, LibreOffice ${lo}`);
  });
  assert.ok(compared > 280, `compared ${compared}`);
  assert.deepEqual(wrong, []);
});

test('the fixed cases', () => {
  const cells = {
    A1: '=3', A2: '=1', A3: '=4', A4: '=1', A5: '=3', A6: '=9',
    B1: '=LARGE(A1:A6,1.5)', B2: '=SMALL(A1:A6,2.9)', B3: '=MODE(A1:A6)', B4: '=MODE.SNGL(A2:A6)', B5: '=PERCENTRANK.INC(A1:A6,2)',
  };
  const ev = bookEvaluator([{ name: 'S', cells }], 0);
  assert.deepEqual(['B1', 'B2', 'B3', 'B4', 'B5'].map((k) => ev(k)), [9, 1, 3, 1, 0.3]);
});
