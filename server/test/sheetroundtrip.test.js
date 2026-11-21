// Random spreadsheets (numbers, text with accents, emoji, two spaces and a line break, 'text, TRUE/FALSE, dates and times,
// formulas, errors) with formats (number, percent, currency, dates, 0.000, bold, italic and colour, fill, underline and
// strikethrough, wrap, alignment) through our .xlsx and .ods and back, and through LibreOffice. The test found an .xlsx
// with a number too big to be a date in a cell formatted as a date stopping the file opening (Excel and LibreOffice write
// such files too: the number is read from the file now), and the plain format 0.000 coming back as Sheets' Number format
// (1,234.500, with thousands separators: it's kept as its own code now).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { soffice, hasSoffice } from './soffice.js';
import { excelFromSheet, sheetFromExcel } from '../src/office/excel.js';
import { odsFromSheet, sheetFromOds } from '../src/office/ods.js';

const VALUES = ['42', '-3.5', '0', '1e-7', '123456789012', '0.1', 'hello', 'Ωmega naïve', '中文', '😀 emoji', 'two  spaces', ' lead', 'a&b<c>"d"', "'007", "'=not a formula", 'TRUE', 'FALSE',
  '2026-11-20', '2026-11-20 14:30', 'line\nbreak', '#N/A', '=1+2', '=A1*2', '=SUM(A1:A3)', '=IF(A1>0,"pos","neg")', '="x"&"y"', '=ROUND(PI(),4)', '=CONCAT("a",1)', '=IFERROR(1/0,"div")', '=Sheet2!A1', '=LEN("abc")', '=XLOOKUP(1,{1,2},{"a","b"})'];
const FMTS = [null, { num: 'number', dp: 2 }, { num: 'percent', dp: 1 }, { num: 'currency', cur: 'USD', dp: 2 }, { num: 'date' }, { num: 'date', ds: 'iso' }, { num: 'custom', code: '0.000' },
  { b: 1 }, { i: 1, color: '#d93025' }, { fill: '#fbbc04' }, { u: 1, s: 1 }, { wrap: 1 }, { align: 'center' }];
function books(n, start) {
  let seed = start; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  return Array.from({ length: n }, () => {
    const cells = {}, formats = {};
    for (let r = 1; r <= 6; r++) for (const c of 'ABCD') if (rnd() < 0.7) { cells[`${c}${r}`] = pick(VALUES); const f = pick(FMTS); if (f) formats[`${c}${r}`] = f; }
    return { sheets: [{ name: 'Sheet1', cells, formats }, { name: 'Sheet2', cells: { A1: '7' }, formats: {} }] };
  });
}
// What a spreadsheet keeps of a cell, with the ways a file stores dates allowed for: a date is a number with a date format
// in .xlsx and .ods, so a date cell comes back with one, a number formatted as a date comes back a date (shown the same),
// and a date given a number format comes back its number. LibreOffice also wraps cells with a line break (and others that
// share their look), makes TRUE with a number or date format that number or date, gives a formula
// the number format of the cell it reads, and can't keep a number too big to be a date in a cell
// formatted as one (it writes year -32768).
const isDate = (v) => /^\d{4}-\d{2}-\d{2}/.test(v);
const dateish = (f) => f?.num === 'date' || /[dy]/.test(f?.code || '');
function differences(want, got, { lo = false } = {}) {
  const out = [];
  for (const key of new Set([...Object.keys(want.cells), ...Object.keys(got.cells || {})])) {
    const a = want.cells[key] ?? '', z = got.cells?.[key] ?? '';
    const fa = { ...(want.formats[key] || {}) }, fz = { ...(got.formats?.[key] || {}) };
    if (isDate(a) && !fa.num) { delete fz.num; delete fz.ds; delete fz.code; }
    if (lo) { delete fa.wrap; delete fz.wrap; } // (LibreOffice wraps cells with a line break, and others that share their look)
    if (lo && a.startsWith('=') && !fa.num) { delete fz.num; delete fz.dp; delete fz.cur; delete fz.ds; delete fz.code; } // (and gives a formula the format of what it refers to)
    const valueOk = a === z || (dateish(fa) && /^-?[\d.e+-]+$/i.test(a) && isDate(z)) || (isDate(a) && fa.num && !dateish(fa) && /^\d/.test(z))
      || (lo && /^(TRUE|FALSE)$/.test(a) && fa.num) || (lo && a === '123456789012' && dateish(fa));
    if (!valueOk) out.push(`${key} ${JSON.stringify(a)} came back ${JSON.stringify(z)}`);
    else if (a !== '' && JSON.stringify(Object.entries(fa).sort()) !== JSON.stringify(Object.entries(fz).filter(([k]) => k in fa || !['font', 'size', 'num', 'ds', 'code'].includes(k)).sort())
      && !(dateish(fa) && /^-?[\d.e+-]+$/i.test(a))) out.push(`${key} ${JSON.stringify(a)} ${JSON.stringify(fa)} came back ${JSON.stringify(fz)}`);
  }
  return out;
}
const FORMATS = [['xlsx', excelFromSheet, sheetFromExcel], ['ods', odsFromSheet, sheetFromOds]];

test('30 random spreadsheets through .xlsx and .ods and back: values and formats kept', async () => {
  for (const [name, to, from] of FORMATS) {
    const wrong = [];
    for (const [k, b] of books(30, 1).entries()) {
      const back = await from(await to(b));
      wrong.push(...differences(b.sheets[0], (back.sheets || back)[0]).map((d) => `#${k} ${d}`));
    }
    assert.deepEqual(wrong, [], name);
  }
});

test('and 30 through LibreOffice, saved again by it as .xlsx and as .ods', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const list = books(30, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetroundtrip-'));
  try {
    for (const [name, to, from] of FORMATS) {
      fs.mkdirSync(path.join(dir, name, 'out'), { recursive: true });
      const files = [];
      for (const [k, b] of list.entries()) { files.push(path.join(dir, name, `b${k}.${name}`)); fs.writeFileSync(files.at(-1), await to(b)); }
      soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', name, '--outdir', path.join(dir, name, 'out'), ...files]);
      const wrong = [];
      for (const [k, b] of list.entries()) {
        const back = await from(fs.readFileSync(path.join(dir, name, 'out', `b${k}.${name}`)));
        wrong.push(...differences(b.sheets[0], (back.sheets || back)[0], { lo: true }).map((d) => `#${k} ${d}`));
      }
      assert.deepEqual(wrong, [], name);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an .xlsx with a number too big to be a date, in a cell formatted as one, opens with the number', async () => {
  const back = await sheetFromExcel(await excelFromSheet({ sheets: [{ name: 'S', cells: { A1: '123456789012', A2: '2026-11-20' }, formats: { A1: { num: 'date' }, A2: { num: 'date' } } }] }));
  assert.deepEqual(back.sheets[0].cells, { A1: '123456789012', A2: '2026-11-20' });
});
