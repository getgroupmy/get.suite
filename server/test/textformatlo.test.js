// TEXT(number, format) as LibreOffice works it out: 16 numbers (negatives, fractions, millions, dates) × 42 formats
// (digits, thousands, percent, scientific, fractions, sections, conditions, dates, times, elapsed hours, General,
// text around digits). The comparison found TEXT(x, "General") giving the word General, "[h]:mm" giving ":12",
// "000-000" putting the dash last, 99.995 as "0.00E+00" giving 10.00E+01, times of negative numbers not shown as times,
// and a dates past the year 9999 stopping the sheet. Where LibreOffice and Excel differ the test follows Excel and says so.
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excelFromSheet } from '../src/office/excel.js';
import { bookEvaluator } from '../src/sheetcalc/formula.js';
import { formatCode } from '../src/sheetcalc/numfmt.js';

const NUMS = [0, 1, -1, 0.5, 1234.5, -1234.567, 0.004, 1e6, 123456789, 0.125, 99.995, -0.4, 45000.75, 2.5, 1e-5, 7];
const FMTS = ['0', '0.00', '#,##0', '#,##0.00', '0%', '0.0%', '0.00E+00', '#', '#.##', '0.###', '00000', '$#,##0.00', '#,##0;(#,##0)',
  '0;-0;"zero"', '# ?/?', '# ??/??', '0.0,', '#,##0,"k"', 'yyyy-mm-dd', 'dd/mm/yyyy', 'mmm d, yyyy', 'dddd', 'mmmm', 'h:mm', 'hh:mm:ss',
  'h:mm AM/PM', '[h]:mm', 'd-mmm-yy', '@', '"x"0', '0 "items"', '#,##0.0_);(#,##0.0)', '[>=1000]#,##0;0', '0.0;[Red]-0.0', 'General',
  '000-000', '?.??', '#,###', 'mm:ss', 'yy', 'd', 'ddd'];

test('TEXT(number, format): the same answers as LibreOffice', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const cells = {}, cases = [];
  let r = 0;
  for (const n of NUMS) for (const f of FMTS) { r++; cells[`A${r}`] = `=${n}`; cells[`H${r}`] = `=TEXT(A${r},"${f.replace(/"/g, '""')}")`; cases.push([n, f]); }
  const book = { sheets: [{ name: 'S', cells }] };
  const ev = bookEvaluator(book.sheets, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textformat-'));
  fs.mkdirSync(path.join(dir, 'profile', 'user'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile', 'user', 'registrymodifications.xcu'), `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>`);
  fs.writeFileSync(path.join(dir, 'b.xlsx'), await excelFromSheet(book));
  soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):9,0,76,1,,1033,false,true,false', '--outdir', dir, path.join(dir, 'b.xlsx')]);
  const lines = fs.readFileSync(path.join(dir, 'b.csv'), 'utf8').replace(/\r/g, '').split('\n');
  fs.rmSync(dir, { recursive: true, force: true });
  const wrong = [];
  let compared = 0;
  cases.forEach(([n, f], i) => {
    const lo = lines[i].split('\t').pop();
    let ours = ev(`H${i + 1}`); ours = String(ours?.error ?? ours);
    // Excel's own answers where LibreOffice's differ: a date or time past 31 Dec 9999 is #VALUE! (LibreOffice: #FMT, or the
    // time of day), and "#.##" keeps the point of a whole number (=TEXT(1, "#.##") is "1." in Excel, "1" in LibreOffice).
    if (n === 123456789 && /[dyhs]|mm/.test(f) && !/[0#]/.test(f)) { assert.equal(ours, '#VALUE!', `${n} as ${f}`); return; }
    if (lo === '#FMT') return;
    if (/^[#0]\.#+$/.test(f) && ours === `${lo}.`) return;
    compared++;
    if (ours !== lo) wrong.push(`TEXT(${n}, "${f}"): ${JSON.stringify(ours)}, LibreOffice ${JSON.stringify(lo)}`);
  });
  assert.ok(compared > 600, `compared ${compared}`);
  assert.deepEqual(wrong, []);
});

test('number formats in cells: General, digits around text, elapsed hours, scientific carry, negative fractions', () => {
  const t = (v, code) => formatCode(v, code)?.text ?? null;
  assert.equal(t(1234.5, 'General'), '1234.5');
  assert.equal(t(1 / 3, 'General'), '0.3333333333');
  assert.equal(t(5, 'General" kg"'), '5 kg');
  assert.equal(t(-5, 'General;(General)'), '(5)');
  assert.equal(t(1234567, '000-000'), '1234-567');
  assert.equal(t(42, '000-000'), '000-042');
  assert.equal(t(1.5, '[h]:mm'), '36:00');
  assert.equal(t(1.5 + 1 / 1440 + 5 / 86400, '[h]:mm:ss'), '36:01:05');
  assert.equal(t(0.25, '[mm]:ss'), '360:00');
  assert.equal(t(99.995, '0.00E+00'), '1.00E+02');
  assert.equal(t(999.96, '##0.0E+0'), '1.0E+3');
  assert.equal(t(-0.4, '# ?/?'), '- 2/5');
  assert.equal(t(-1.5, '# ?/?'), '-1 1/2');
  assert.equal(t(-0.4, 'h:mm'), null); // a negative time in a cell: no time (Excel shows ####)
});
