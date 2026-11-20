// Lookups and conditional sums over a sorted column of numbers, a sorted column of text (with an accent and capitals), an
// unsorted mixed one (numbers, text, an empty cell, a*b, TRUE): VLOOKUP, MATCH, LOOKUP, COUNTIF, SUMIF and INDEX, 30 each
// at random, worked out again by LibreOffice. The comparison found COUNTIF(range, "a~*b") not finding the text a*b (a ~
// before * or ? makes it plain), and LOOKUP("eclair", a column of numbers) giving the last number (Excel: #N/A).
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excelFromSheet } from '../src/office/excel.js';
import { bookEvaluator } from '../src/sheetcalc/formula.js';

// Not compared: XLOOKUP and XMATCH (this LibreOffice doesn't have them); an approximate search of the unsorted mixed
// column (a binary search's answer there depends on how it halves); and where Excel and LibreOffice part ways, Sheets doing
// as Excel: TRUE isn't 1 (COUNTIF(numbers, TRUE) is 0, and "<5" doesn't pick TRUE), "*" matches text only, the text "3"
// isn't the number 3, an approximate LOOKUP doesn't take * as a wildcard, and INDEX(…, 0, n) gives the whole column (it
// spills, here into other cells: #SPILL!).
const NOT_COMPARED = /XLOOKUP|XMATCH|INDEX\(A1:D8,(0,|[^,]+,0\))|C1:C8,(1|-1)\)|C1:D8,2,(1|TRUE)\)|LOOKUP\([^,]+,C1:C8,D1:D8\)|TRUE|"\*"|"<5"|^=VLOOKUP\("3",|LOOKUP\("[bc]\*"/;

test('lookups and conditional sums: the same answers as LibreOffice', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  // sorted A (numbers), sorted B (text), unsorted C (mixed), D values; row 1 to 8
  const cells = {
    A1: '=1', A2: '=3', A3: '=3', A4: '=5', A5: '=8', A6: '=13', A7: '=21', A8: '=40',
    B1: 'apple', B2: 'Banana', B3: 'cherry', B4: 'date', B5: 'Éclair', B6: 'fig', B7: 'grape', B8: 'kiwi',
    C1: '=7', C2: 'pear', C3: '=2', C4: 'Apple', C5: '=7', C6: '', C7: 'a*b', C8: '=TRUE',
    D1: 'd1', D2: 'd2', D3: 'd3', D4: 'd4', D5: 'd5', D6: 'd6', D7: 'd7', D8: 'd8',
  };
  const KEYS = ['0', '1', '2', '3', '4', '8', '40', '41', '-1', '7', '"3"', '"apple"', '"APPLE"', '"b*"', '"?ig"', '"date"', '"dates"', '"eclair"', '"zzz"', '"a"', '"a~*b"', '"pear"', 'TRUE', '""', '2.5', '"c*"'];
  let seed = 9; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const col = () => pick(['A', 'B', 'C']);
  const T = [
    () => { const c = col(); return `=VLOOKUP(${pick(KEYS)},${c}1:D8,${c === 'A' ? 4 : c === 'B' ? 3 : 2},${pick(['TRUE', 'FALSE', '0', '1'])})`; },
    () => `=MATCH(${pick(KEYS)},${col()}1:${pick(['A', 'B', 'C'])}8,${pick(['0', '1', '-1'])})`.replace(/(\w)1:\w8/, (m, a) => `${a}1:${a}8`),
    () => `=XLOOKUP(${pick(KEYS)},${col()}1:${'X'}8,D1:D8,"none",${pick(['0', '-1', '1', '2'])},${pick(['1', '-1', '2', '-2'])})`.replace(/(\w)1:X8/, (m, a) => `${a}1:${a}8`),
    () => `=XMATCH(${pick(KEYS)},${col()}1:X8,${pick(['0', '-1', '1', '2'])},${pick(['1', '-1'])})`.replace(/(\w)1:X8/, (m, a) => `${a}1:${a}8`),
    () => `=LOOKUP(${pick(KEYS)},${col()}1:X8,D1:D8)`.replace(/(\w)1:X8/, (m, a) => `${a}1:${a}8`),
    () => `=COUNTIF(${col()}1:X8,${pick(KEYS)})`.replace(/(\w)1:X8/, (m, a) => `${a}1:${a}8`),
    () => `=SUMIF(${col()}1:X8,${pick(['">3"', '"<>7"', '"=7"', '">=b"', '"<>"', '"="', '7', '"*"', '"<5"', '">apple"'])},A1:A8)`.replace(/(\w)1:X8/, (m, a) => `${a}1:${a}8`),
    () => `=INDEX(A1:D8,${pick(['1', '8', '0', '9', '2.7', '-1'])},${pick(['1', '4', '0', '5', '1.9'])})`,
  ];
  const cases = [];
  let r = 0;
  for (const t of T) for (let k = 0; k < 30; k++) { r++; cells[`H${r}`] = t(); cases.push(cells[`H${r}`]); }
  const book = { sheets: [{ name: 'S', cells }] };
  const ev = bookEvaluator(book.sheets, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookuplo-'));
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
  cases.forEach((c, i) => {
    if (NOT_COMPARED.test(c)) return;
    let ours = ev(`H${i + 1}`);
    ours = String(ours?.error ?? ours);
    const lo = lines[i].split('\t').pop();
    compared++;
    if (ours !== lo && !(/^Err:5/.test(lo) && /^#/.test(ours))) wrong.push(`${c}: ${ours}, LibreOffice ${lo}`);
  });
  assert.ok(compared > 100, `compared ${compared}`);
  assert.deepEqual(wrong, []);
});

test('the fixed cases, and Excel’s answers where LibreOffice’s differ', () => {
  const cells = {
    A1: '=1', A2: '=3', A3: '=5', B1: 'a*b', B2: 'ab', B3: 'axb', C1: '=TRUE',
    D1: '=COUNTIF(B1:B3,"a~*b")', D2: '=IFERROR(LOOKUP("eclair",A1:A3),"none")', D3: '=MATCH("a~*b",B1:B3,0)', D4: '=COUNTIF(B1:B3,"a*b")',
    D5: '=IFERROR(VLOOKUP("3",A1:A3,1,FALSE),"none")', D6: '=COUNTIF(A1:C3,TRUE)', D7: '=LOOKUP(4,A1:A3)', D8: '=IFERROR(LOOKUP(4,B1:B3),"none")',
    D9: '=ERROR.TYPE(INDEX(A1:A3,-1))',
  };
  const ev = bookEvaluator([{ name: 'S', cells }], 0);
  const got = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'].map((k) => { const v = ev(k); return v?.error ?? v; });
  assert.deepEqual(got, [1, 'none', 1, 3, 'none', 1, 3, 'none', 3]); // (INDEX of row -1: #VALUE!, error type 3, as in Excel; a*b matches all three: ab, axb and a*b itself)
});
