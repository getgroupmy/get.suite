// Custom number codes in .ods files: written as OpenDocument number styles the way LibreOffice writes them (text,
// scaling, colours, sections), read back as the codes they were, and shown by LibreOffice as Sheets shows them.
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { odsFromSheet, sheetFromOds } from '../src/office/ods.js';
import { formatCode } from '../src/sheetcalc/numfmt.js';

const CASES = [['0.0,"k"', 1234.5], ['#,##0.00 "kg"', 12.5], ['0;(0)', -5], ['[Red]0.00;[Blue]-0.00', -3.25], ['#,##0;-#,##0;"zero"', 0], ['0.0,,"M"', 2500000], ['0.0%', 0.125], ['"Total: "0', 42],
  // conditions and fractions
  ['[>100]0;0.00', 150], ['[Blue][>=1000]#,##0;[Red]0', 50], ['# ?/?', 1.5], ['# ??/16', 0.3125], ['?/?', 0.75], ['0 ?/8', 2.375], ['[=1]"one";0', 1], ['[<0]"neg";[>0]"pos";"zero"', -2]];
const book = { sheets: [{ name: 'S', cells: Object.fromEntries(CASES.map(([, v], i) => [`A${i + 1}`, String(v)])), formats: Object.fromEntries(CASES.map(([code], i) => [`A${i + 1}`, { num: 'custom', code }])) }] };

test('custom number codes go into .ods as number styles and come back as the same codes', async () => {
  const back = (await sheetFromOds(await odsFromSheet(book))).sheets[0];
  CASES.slice(0, 6).forEach(([code], i) => assert.deepEqual(back.formats[`A${i + 1}`], { num: 'custom', code }, code));
  assert.deepEqual(back.formats.A7, { num: 'percent', dp: 1 }, '0.0% is a plain percentage: Percent, 1 decimal');
  assert.equal(formatCode(42, back.formats.A8.code).text, 'Total: 42', 'written a little differently, shown the same');
  CASES.slice(8, 15).forEach(([code], i) => assert.deepEqual(back.formats[`A${i + 9}`], { num: 'custom', code }, code));
  assert.equal(back.formats.A16.code, '"pos";"neg";"zero"', 'conditions that are the usual positive;negative;zero come back as those');
  // what can't be kept (exponents, @ text sections) is left out rather than written wrong
  const other = (await sheetFromOds(await odsFromSheet({ sheets: [{ name: 'S', cells: { A1: '5' }, formats: { A1: { num: 'custom', code: '0.00E+00' } } }] }))).sheets[0];
  assert.equal(other.formats?.A1, undefined);
});

test('LibreOffice shows them as Sheets does', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odsnum-'));
  fs.writeFileSync(path.join(dir, 'n.ods'), await odsFromSheet(book));
  soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true', '--outdir', dir, path.join(dir, 'n.ods')]);
  const shown = fs.readFileSync(path.join(dir, 'n.csv'), 'utf8').trim().split(/\r?\n/).map((l) => l.replace(/^"|"$/g, ''));
  assert.deepEqual(shown, CASES.map(([code, v]) => formatCode(v, code).text));
  fs.rmSync(dir, { recursive: true, force: true });
});
