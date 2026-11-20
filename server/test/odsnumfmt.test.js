// Custom number codes in .ods files: written as OpenDocument number styles the way LibreOffice writes them (text,
// scaling, colours, sections), read back as the codes they were, and shown by LibreOffice as Sheets shows them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { odsFromSheet, sheetFromOds } from '../src/office/ods.js';
import { formatCode } from '../src/sheetcalc/numfmt.js';

const CASES = [['0.0,"k"', 1234.5], ['#,##0.00 "kg"', 12.5], ['0;(0)', -5], ['[Red]0.00;[Blue]-0.00', -3.25], ['#,##0;-#,##0;"zero"', 0], ['0.0,,"M"', 2500000], ['0.0%', 0.125], ['"Total: "0', 42]];
const book = { sheets: [{ name: 'S', cells: Object.fromEntries(CASES.map(([, v], i) => [`A${i + 1}`, String(v)])), formats: Object.fromEntries(CASES.map(([code], i) => [`A${i + 1}`, { num: 'custom', code }])) }] };

test('custom number codes go into .ods as number styles and come back as the same codes', async () => {
  const back = (await sheetFromOds(await odsFromSheet(book))).sheets[0];
  CASES.slice(0, 6).forEach(([code], i) => assert.deepEqual(back.formats[`A${i + 1}`], { num: 'custom', code }, code));
  assert.deepEqual(back.formats.A7, { num: 'percent', dp: 1 }, '0.0% is a plain percentage: Percent, 1 decimal');
  assert.equal(formatCode(42, back.formats.A8.code).text, 'Total: 42', 'written a little differently, shown the same');
  // what can't be kept (conditions, fractions) is left out rather than written wrong
  const other = (await sheetFromOds(await odsFromSheet({ sheets: [{ name: 'S', cells: { A1: '5', A2: '1.5' }, formats: { A1: { num: 'custom', code: '[>100]0;0' }, A2: { num: 'custom', code: '# ?/?' } } }] }))).sheets[0];
  assert.equal(other.formats?.A1, undefined);
  assert.equal(other.cells.A2, '1.5');
});

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
test('LibreOffice shows them as Sheets does', { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odsnum-'));
  fs.writeFileSync(path.join(dir, 'n.ods'), await odsFromSheet(book));
  execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true', '--outdir', dir, path.join(dir, 'n.ods')], { stdio: 'ignore', timeout: 120000 });
  const shown = fs.readFileSync(path.join(dir, 'n.csv'), 'utf8').trim().split(/\r?\n/).map((l) => l.replace(/^"|"$/g, ''));
  assert.deepEqual(shown, CASES.map(([code, v]) => formatCode(v, code).text));
  fs.rmSync(dir, { recursive: true, force: true });
});
