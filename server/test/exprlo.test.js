// Formulas made at random from numbers, cell references ($A$1, A$2), SUM, MAX, PI and brackets with + - * / ^ & and
// unary -, + and %, three levels deep (400 of them), worked out again by LibreOffice: how a formula is read (-2^2 is 4,
// 2^-2^2 is 0.0625) and worked out. The comparison found an answer that's no number, as (-10)^1.5, carried through a
// comparison as FALSE instead of #NUM! (=1<-10^1.5 is #NUM! in Excel), the same for a function's (=1<POWER(-10, 1.5)),
// and 0^0 giving 1 (Excel: #NUM!) and 0^-1 #NUM! (Excel: #DIV/0!).
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excelFromSheet } from '../src/office/excel.js';
import { bookEvaluator } from '../src/sheetcalc/formula.js';

// Not compared: formulas with a comparison (= or <) in them, as LibreOffice has no TRUE and FALSE of their own (they're 1
// and 0, so TRUE<3 is TRUE and TRUE&"" is "1"; in Excel TRUE is above any number), and 0 to a power of 0 (1 there).
const NOT_COMPARED = /[=<]|0\^\(?0[^.]/;

test('formulas at random: read and worked out as LibreOffice does', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const cells = { A1: '=2', A2: '=3', A3: '=-1.5', B1: '=10', B2: '=0.5', B3: '=4' };
  let seed = 31; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const atom = () => pick(['2', '3', '0.5', '10', '1.5', 'A1', 'A2', 'A3', 'B1', 'B2', '$A$1', 'A$2', 'SUM(A1:B3)', 'MAX(A1:A3)', '(1)', 'PI()', '4']);
  function expr(d) {
    if (d <= 0 || rnd() < 0.25) {
      let a = atom();
      const u = rnd();
      if (u < 0.12) a = `-${a}`; else if (u < 0.17) a = `+${a}`; else if (u < 0.22) a = `${a}%`; else if (u < 0.25) a = `--${a}`;
      return a;
    }
    const op = pick(['+', '-', '*', '/', '^', '+', '-', '*', '&', '=', '<']);
    const l = expr(d - 1), r = expr(d - 1);
    const sp = rnd() < 0.2 ? ' ' : '';
    const e = `${l}${sp}${op}${sp}${r}`;
    return rnd() < 0.3 ? `(${e})` : e;
  }
  const cases = [];
  let r = 0;
  for (let k = 0; k < 400; k++) { r++; cells[`H${r}`] = `=${expr(3)}`; cases.push(cells[`H${r}`]); }
  const book = { sheets: [{ name: 'S', cells }] };
  const ev = bookEvaluator(book.sheets, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exprlo-'));
  fs.mkdirSync(path.join(dir, 'profile', 'user'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile', 'user', 'registrymodifications.xcu'), `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>`);
  fs.writeFileSync(path.join(dir, 'b.xlsx'), await excelFromSheet(book));
  soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):9,0,76,1,,1033,false,true,false', '--outdir', dir, path.join(dir, 'b.xlsx')]);
  const lines = fs.readFileSync(path.join(dir, 'b.csv'), 'utf8').replace(/\r/g, '').split('\n');
  fs.rmSync(dir, { recursive: true, force: true });
  // (numbers equal to 13 places; text joined with & compared as written, its numbers to 15 digits as both write them)
  const same = (a, b) => a === b || (a !== '' && b !== '' && Number.isFinite(+a) && Number.isFinite(+b) && Math.abs(+a - +b) <= 1e-13 * Math.max(1, Math.abs(+b)))
    || a.replace(/\d+\.\d+/g, (x) => Number(x).toPrecision(13)) === b.replace(/\d+\.\d+/g, (x) => Number(x).toPrecision(13));
  const wrong = [];
  let compared = 0;
  cases.forEach((c, i) => {
    if (NOT_COMPARED.test(c.slice(1))) return;
    let ours = ev(`H${i + 1}`);
    ours = String(ours?.error ?? ours);
    let lo = lines[i].split('\t').pop();
    if (/^-?[\d.E+-]+%$/.test(lo)) lo = String(Number(lo.slice(0, -1)) / 100); // (shown as a percentage)
    compared++;
    if (!same(ours, lo)) wrong.push(`${c}: ${ours}, LibreOffice ${lo}`);
  });
  assert.ok(compared > 200, `compared ${compared}`);
  assert.deepEqual(wrong, []);
});

test('no number carried through as an answer: #NUM! there and then, as in Excel', () => {
  const cells = {
    A1: '=ERROR.TYPE(1<-10^1.5)', A2: '=ERROR.TYPE(1<POWER(-10,1.5))', A3: '=ERROR.TYPE(0^0)', A4: '=ERROR.TYPE(0^-1)', A5: '=IFERROR(1<SQRT(-1),"no")',
    A6: '=-2^2', A7: '=2^-2^2', A8: '=1--2^2', A9: '=ERROR.TYPE(1E+200*1E+200>0)',
  };
  const ev = bookEvaluator([{ name: 'S', cells }], 0);
  assert.deepEqual(Object.keys(cells).map((k) => ev(k)), [6, 6, 6, 2, 'no', 4, 0.0625, -3, 6]);
});
