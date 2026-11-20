// The number formats cells use (sheetcalc/numfmt.js) against LibreOffice: 40 common codes on five values, written to an
// .xlsx (which keeps the codes as written), shown by LibreOffice as text (CSV "as shown"), and compared one by one.
// (Where LibreOffice and Excel differ, Excel's way is kept: "#.##" shows "." for 0 and "1234567." in Excel.)
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excelFromSheet } from '../src/office/excel.js';
import { formatCode } from '../src/sheetcalc/numfmt.js';

const CODES = ['0', '0.00', '#,##0', '#,##0.00', '0%', '0.00%', '0.0,"k"', '#,##0,,"M"', '0.00E+00', '##0.0E+0', '00000', '0.0#', '$#,##0.00', '$#,##0.00;($#,##0.00)',
  '[Red]-0.00', '#,##0;[Red]-#,##0', '0;-0;"-"', '"$"#,##0_);("$"#,##0)', '#,##0.00 "USD"', '?.??', '#,##0.00_-', '0 "items"', '+0;-0;0', '#,###', '0.000', '#',
  '0.0%;-0.0%', '[Blue]#,##0;[Red]-#,##0;[Green]0', '# ?/?', '#,##0.0,', '@', '0.00;@', '"Value: "0.0', '00.00', '#,##0.00;-#,##0.00;"–"',
  '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)', '0.0" kg"', '[>=1000]#,##0,"K";0', '0.00%;[Red]-0.00%'];
const VALUES = [1234.567, -1234.567, 0, 0.5, 1234567];

test('cells show numbers in these formats as LibreOffice does', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const cells = {}, formats = {}, ours = [];
  CODES.forEach((code, i) => VALUES.forEach((v, j) => { const k = `${String.fromCharCode(65 + j)}${i + 1}`; cells[k] = String(v); formats[k] = { num: 'custom', code }; ours.push(formatCode(v, code)?.text ?? ''); }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numfmt-'));
  fs.writeFileSync(path.join(dir, 'f.xlsx'), await excelFromSheet({ sheets: [{ name: 'S', cells, formats }] }));
  soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true', '--outdir', dir, path.join(dir, 'f.xlsx')]);
  const rows = fs.readFileSync(path.join(dir, 'f.csv'), 'utf8').replace(/\r/g, '').split('\n').filter((l, i, a) => i < a.length - 1 || l);
  const parse = (line) => { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  const lo = rows.flatMap((l) => { const r = parse(l); return Array.from({ length: VALUES.length }, (_, j) => r[j] ?? ''); });
  const diffs = ours.map((o, i) => (o === lo[i] ? null : `${CODES[Math.floor(i / VALUES.length)]} ${VALUES[i % VALUES.length]}: ours ${JSON.stringify(o)}, LibreOffice ${JSON.stringify(lo[i])}`)).filter(Boolean);
  assert.deepEqual(diffs, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
