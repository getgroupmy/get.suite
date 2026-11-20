// Operators (+ - * / ^ & = <> < >= %, precedence, -2^2) and logical and information functions (AND, OR, XOR, NOT, IF,
// IFS, SWITCH, CHOOSE, TYPE, N, IS…, ERROR.TYPE) over numbers, text, "", an empty cell, a number written as text and an
// error, 27 kinds of call 14 times each at random, worked out again by LibreOffice. The comparison found "" (empty text,
// as a formula's "" gives) taken as 0 in sums (=5+"" is #VALUE! in Excel) and as FALSE by IF and NOT, ISTEXT("") FALSE
// and TYPE("") 1 (it's text: TRUE, 2), and AND, OR and XOR refusing text in a cell instead of passing over it
// (=AND(3, A2) with text in A2 is TRUE).
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excelFromSheet } from '../src/office/excel.js';
import { bookEvaluator } from '../src/sheetcalc/formula.js';

// Not compared, where LibreOffice isn't Excel: it has no TRUE and FALSE of their own (they're 1 and 0, so TRUE<2 is TRUE,
// COUNT counts a TRUE cell and TRUE&"" is 1), writes the IS… functions' answers as 1 and 0, gives TYPE 8 for any formula
// cell, refuses SUM(0, "3") (Excel adds a number typed as text), AVERAGE("", …) as #DIV/0! and SWITCH(-0, …) as #VALUE!,
// ERROR.TYPE(SQRT(-1)) as #N/A (Excel: 6, for #NUM!), ISEVEN("3") (Excel reads the number), and 0^0 as 1 (Excel:
// #NUM!).
const NOT_COMPARED = /TRUE|FALSE|^=ISEVEN\("3"\)|^=COUNT\(|^=ISNUMBER|^=TYPE\(A[16]\)|^=SUM\(.*"3"|^=AVERAGE\(""|^=SWITCH\(-0|SQRT\(-1\)|=0\^/;

test('operators and logical functions: the same answers as LibreOffice', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const cells = { A1: '=5', A2: 'text', A3: '', A4: '=TRUE', A5: '=1/0', A6: '="7"', A7: '=-2', A8: '=0.5' };
  const V = ['2', '-2', '0', '0.5', '3', '"a"', '"3"', 'TRUE', 'FALSE', 'A1', 'A2', 'A3', 'A6', 'A7', '""', '10%', '1E+3', '-0', '(1/3)'];
  const OPS = ['+', '-', '*', '/', '^', '&', '=', '<>', '<', '>=', '%'];
  let seed = 19; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const bin = () => { const o = pick(OPS); return o === '%' ? `${pick(V)}%` : `${pick(V)}${o}${pick(V)}`; };
  const T = [
    () => `=${bin()}`, () => `=${bin()}`, () => `=${bin()}${pick(OPS.slice(0, 7))}${pick(V)}`, () => `=-${pick(V)}^${pick(['2', '0.5', '3', '-1'])}`,
    () => `=${pick(V)}^${pick(V)}^${pick(['2', '0.5'])}`, () => `=-${pick(V)}%`, () => `=${pick(V)}&${pick(V)}+${pick(V)}`, () => `=${pick(V)}=${pick(V)}=${pick(['TRUE', 'FALSE'])}`,
    () => `=AND(${pick(V)},${pick(V)})`, () => `=OR(${pick(['A1:A4', 'A2:A3', 'A1:A8', pick(V)])})`, () => `=XOR(${pick(V)},${pick(V)},${pick(V)})`, () => `=NOT(${pick(V)})`,
    () => `=IF(${pick(V)},"y","n")`, () => `=CHOOSE(${pick(['1', '2', '2.9', '0', '4', 'TRUE'])},"a","b","c")`, () => `=TYPE(${pick(V)})`, () => `=N(${pick(V)})`,
    () => `=ISNUMBER(${pick(V)})&ISTEXT(${pick(V)})&ISLOGICAL(${pick(V)})&ISBLANK(${pick(V)})`, () => `=ISEVEN(${pick(V)})`, () => `=SUM(${pick(V)},${pick(V)})`, () => `=MAX(${pick(V)},${pick(V)},A1:A4)`,
    () => `=IFS(${pick(V)},"a",${pick(V)},"b")`, () => `=SWITCH(${pick(V)},2,"two","a","A",3,"three","other")`, () => `=COUNT(${pick(V)},${pick(V)},A1:A8)`, () => `=AVERAGE(${pick(V)},A1:A8)`,
    () => `=SIGN(${pick(V)})`, () => `=${pick(V)}*${pick(V)}/${pick(['0', '2', 'A3', 'A2'])}`, () => `=ERROR.TYPE(${pick(['A5', '1/0', 'NA()', 'SQRT(-1)', '"a"+1', 'A1', '#REF!'])})`,
  ];
  const cases = [];
  let r = 0;
  for (const t of T) for (let k = 0; k < 14; k++) { r++; cells[`H${r}`] = t(); cases.push(cells[`H${r}`]); }
  const book = { sheets: [{ name: 'S', cells }] };
  const ev = bookEvaluator(book.sheets, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oplo-'));
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
    ours = typeof ours === 'boolean' ? String(ours).toUpperCase() : String(ours?.error ?? ours);
    let lo = lines[i].split('\t').pop();
    if (/^-?[\d.E+-]+%$/.test(lo)) lo = String(Number(lo.slice(0, -1)) / 100); // (shown as a percentage: 5% is 0.05)
    compared++;
    if (!same(ours, lo)) wrong.push(`${c}: ${ours}, LibreOffice ${lo}`);
  });
  assert.ok(compared > 250, `compared ${compared}`);
  assert.deepEqual(wrong, []);
});

test('the fixed cases, as in Excel', () => {
  const cells = {
    A1: 'text', A2: '=""', B1: '=ERROR.TYPE(5+"")', B2: '=ISTEXT("")', B3: '=TYPE(A2)', B4: '=AND(3,A1)', B5: '=XOR(1,A1,0)', B6: '=ERROR.TYPE(NOT(""))',
    B7: '=ERROR.TYPE(IF(A2,1,2))', B8: '=AND("true",1)', B9: '=ERROR.TYPE(OR(A1))', B10: '=A3+1', B11: '=ISBLANK(A2)',
  };
  const ev = bookEvaluator([{ name: 'S', cells }], 0);
  assert.deepEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11'].map((k) => ev(k)), [3, true, 2, true, true, 3, 3, true, 3, 1, false]);
});
