// OpenDocument stores some function names its own way: Excel's with COM.MICROSOFT. before them, old statistics with
// LEGACY., and three by other names. Written plainly, LibreOffice shows #NAME?; read from a LibreOffice file, they
// come back as Sheets' names. Also: a control character in a cell (CHAR(1)) can't make the file unreadable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { formulaToOds, formulaFromOds, odsFromSheet, sheetFromOds } from '../src/office/ods.js';
import { excelFromSheet } from '../src/office/excel.js';
import { odtFromDoc } from '../src/office/odt.js';
import { powerPointFromDeck } from '../src/office/powerpoint.js';

test('written as OpenDocument names them, and read back as Sheets does', () => {
  assert.equal(formulaToOds('=STDEV.S(A1:A3)+SUM(B1)'), 'of:=COM.MICROSOFT.STDEV.S([.A1:.A3])+SUM([.B1])');
  assert.equal(formulaToOds('=NORMSDIST(1)'), 'of:=LEGACY.NORMSDIST(1)');
  assert.deepEqual([formulaToOds('=FORMULATEXT(A1)'), formulaToOds('=SKEW.P(A1:A9)'), formulaToOds('=ECMA.CEILING(4.2,1)')], ['of:=FORMULA([.A1])', 'of:=SKEWP([.A1:.A9])', 'of:=COM.MICROSOFT.CEILING(4.2;1)']);
  assert.equal(formulaToOds('=IFS(A1>3,"STDEV.S(x)",TRUE,"no")'), 'of:=COM.MICROSOFT.IFS([.A1]>3;"STDEV.S(x)";TRUE;"no")', 'not inside text');
  assert.equal(formulaToOds('=SEC(0)+GAMMA(5)'), 'of:=SEC(0)+GAMMA(5)', 'ones LibreOffice knows plainly stay so');
  for (const f of ['=STDEV.S(A1:A3)', '=TEXTJOIN("-",TRUE,A1:A3)', '=FORMULATEXT(A1)', '=SKEW.P(A1:A9)', '=NORMSINV(0.5)', '=MAXIFS(A1:A3,A1:A3,">5")']) assert.equal(formulaFromOds(formulaToOds(f)), f);
  assert.equal(formulaFromOds('of:=COM.MICROSOFT.XLOOKUP([.A1];[.B1:.B3];[.C1:.C3])'), '=XLOOKUP(A1,B1:B3,C1:C3)', 'any other COM.MICROSOFT. one');
});

test('a control character in a cell or a document leaves the file readable', async () => {
  const ods = await odsFromSheet({ sheets: [{ name: 'Sheet1', cells: { A1: 'bell\u0007here', A2: '=CHAR(1)&"x"' } }] });
  const xml = await (await JSZip.loadAsync(ods)).file('content.xml').async('string');
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml), 'no control characters in content.xml');
  const back = await sheetFromOds(ods);
  assert.equal(back.sheets[0].cells.A1, 'bellhere');
  const odt = await odtFromDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'tab\u0001bed' }] }] }, 'T');
  assert.ok(!/[\u0000-\u0008]/.test(await (await JSZip.loadAsync(odt)).file('content.xml').async('string')));
});

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
test('LibreOffice works them out, and a file it made comes back with Sheets’ names', { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-odsnames-'));
  try {
    const cells = { A1: '5', A2: '7', A3: '9', B1: '=STDEV.S(A1:A3)', B2: '=IFS(A1>3,"big",TRUE,"small")', B3: '=TEXTJOIN("-",TRUE,A1:A3)', B4: '=AGGREGATE(9,6,A1:A3)', B5: '=NORMSDIST(0)', B6: '=SKEW.P({1,2,9})' };
    fs.writeFileSync(path.join(dir, 'ours.ods'), await odsFromSheet({ sheets: [{ name: 'Sheet1', cells }] }));
    execFileSync('soffice', ['--headless', '--convert-to', 'csv', '--outdir', dir, path.join(dir, 'ours.ods')], { stdio: 'ignore', timeout: 120000 });
    const col = fs.readFileSync(path.join(dir, 'ours.csv'), 'utf8').trim().split(/\r?\n/).map((l) => l.split(',')[1]);
    assert.deepEqual(col.slice(0, 5), ['2', 'big', '5-7-9', '21', '0.5']);
    assert.ok(!col.includes('#NAME?'), col.join(' '));
    // A LibreOffice file (made from an Excel one): its names come back as Sheets'.
    fs.writeFileSync(path.join(dir, 'theirs.xlsx'), await excelFromSheet({ sheets: [{ name: 'Sheet1', cells }] }));
    execFileSync('soffice', ['--headless', '--convert-to', 'ods', '--outdir', dir, path.join(dir, 'theirs.xlsx')], { stdio: 'ignore', timeout: 120000 });
    const back = (await sheetFromOds(fs.readFileSync(path.join(dir, 'theirs.ods')))).sheets[0].cells;
    assert.deepEqual([back.B1, back.B2, back.B3, back.B5], ['=STDEV.S(A1:A3)', '=IFS(A1>3,"big",TRUE,"small")', '=TEXTJOIN("-",TRUE,A1:A3)', '=NORMSDIST(0)']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a control character in a slide leaves the PowerPoint file whole (it used to empty that slide)', async () => {
  const deck = { slides: [{ id: 's1', items: [{ id: 'b1', type: 'text', x: 10, y: 10, w: 80, h: 20, text: 'Plan \u0001for 2027 🎉' }], notes: 'Say hello \u0007' }] };
  const buf = await powerPointFromDeck(deck, { title: 'Plan\u0002' });
  const z = await JSZip.loadAsync(buf);
  for (const f of Object.keys(z.files).filter((n) => n.endsWith('.xml'))) assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(await z.file(f).async('string')), f);
  assert.match(await z.file('ppt/slides/slide1.xml').async('string'), /Plan for 2027 🎉/);
  if (!soffice) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-pptx-'));
  try {
    fs.writeFileSync(path.join(dir, 'd.pptx'), buf);
    execFileSync('soffice', ['--headless', '--convert-to', 'odp', '--outdir', dir, path.join(dir, 'd.pptx')], { stdio: 'ignore', timeout: 120000 });
    const content = await (await JSZip.loadAsync(fs.readFileSync(path.join(dir, 'd.odp')))).file('content.xml').async('string');
    assert.match(content, /Plan for 2027/, 'LibreOffice reads the slide’s text');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
