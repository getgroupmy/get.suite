// Comparing text in formulas (=A1<B1, COUNTIF "<m", lookups) as LibreOffice and Excel do: accents with their letter (é
// with e, Ä with A, before Z), any case the same, and numbers before any text. Random pairs from a pool of awkward
// values, worked out by LibreOffice (recalculated on load) and compared. TRUE/FALSE are left to the second test: Excel
// puts them after all text, LibreOffice takes them for 1 and 0.
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excelFromSheet } from '../src/office/excel.js';
import { bookEvaluator } from '../src/sheetcalc/formula.js';

const POOL = ['=100', '=9', '=0', '=-1', 'apple', 'Apple', 'APPLE', 'banana', 'Äpfel', 'apfel', 'éclair', 'eclair', 'Zebra', 'zebra', 'item10', 'item9', 'item 10',
  'a-b', 'ab', 'a b', '中文', '中国', 'ไทย', 'Ωmega', 'omega', 'ñu', 'nu', '', ' a', '1abc', '#tag', 'ö', 'o', 'Œuvre', 'oeuvre', 'Ålesund', 'Ærø', 'ae'];

async function libreOffice(book) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textorder-'));
  fs.mkdirSync(path.join(dir, 'profile', 'user'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile', 'user', 'registrymodifications.xcu'), `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>`);
  fs.writeFileSync(path.join(dir, 'b.xlsx'), await excelFromSheet(book));
  soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):44,34,76,1,,1033,false,true,false', '--outdir', dir, path.join(dir, 'b.xlsx')]);
  const lines = fs.readFileSync(path.join(dir, 'b.csv'), 'utf8').replace(/\r/g, '').split('\n');
  fs.rmSync(dir, { recursive: true, force: true });
  return lines.map((l) => (l.split(',').pop() || '').trim());
}

test('comparing text and numbers: the same answers as LibreOffice', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = () => POOL[Math.floor(rnd() * POOL.length)];
  const cells = {}, cases = [];
  ['<', '=', '>='].forEach((op, k) => {
    for (let i = 1; i <= 150; i++) {
      const row = k * 150 + i, a = pick(), b = pick();
      if (a) cells[`A${row}`] = a; if (b) cells[`B${row}`] = b;
      cells[`H${row}`] = `=A${row}${op}B${row}`;
      cases.push({ row, text: `${JSON.stringify(a)} ${op} ${JSON.stringify(b)}` });
    }
  });
  const book = { sheets: [{ name: 'S', cells }] };
  const ours = bookEvaluator(book.sheets, 0), lo = await libreOffice(book);
  const bad = cases.filter((c) => { const v = ours(`H${c.row}`); return (v === true ? 'TRUE' : v === false ? 'FALSE' : String(v)) !== lo[c.row - 1]; });
  assert.deepEqual(bad.map((c) => `${c.text}: LibreOffice ${lo[c.row - 1]}`), []);
});

test('Excel\'s order between kinds: numbers, text, then TRUE/FALSE; a blank is 0, "" or FALSE', () => {
  const ev = bookEvaluator([{ name: 'S', cells: { A1: '=TRUE()>"zzz"', A2: '=FALSE()>100', A3: '=100<"1"', A4: '="Äpfel"<"Zebra"', A5: '=C1=FALSE()', A6: '=C1=0', A7: '=C1=""', A8: '=COUNTIF(D1:D4,"<m")', A9: '="éclair"<"f"',
    D1: 'Äpfel', D2: 'zebra', D3: 'éclair', D4: 'Zürich' } }], 0);
  assert.deepEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9'].map((k) => ev(k)), [true, true, true, true, true, true, true, 2, true]);
});
