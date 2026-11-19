// Hidden sheets: kept hidden in Excel and OpenDocument files both ways (one is always shown, and the file opens on it),
// through live editing, and through LibreOffice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { excelFromSheet, sheetFromExcel } from '../src/office/excel.js';
import { odsFromSheet, sheetFromOds } from '../src/office/ods.js';
import { sheetDocFromJson, jsonFromSheetDoc, applySheetJson } from '../src/collabdoc.js';

const sheet = { sheets: [{ name: 'Lookup', hidden: true, cells: { A1: '5' } }, { name: 'Report', cells: { A1: '=Lookup!A1*2' } }, { name: 'Old', hidden: true, tabColor: '#757575', cells: { A1: 'x' } }] };
const show = (d) => d.sheets.map((s) => [s.name, !!s.hidden, s.tabColor || null]);
const want = [['Lookup', true, null], ['Report', false, null], ['Old', true, '#757575']];
const allHidden = { sheets: [{ name: 'A', hidden: true, cells: {} }, { name: 'B', hidden: true, cells: {} }] };

test('.xlsx: hidden sheets as Excel\'s, opening on the first shown one; never all hidden', async () => {
  const buf = await excelFromSheet(sheet);
  const zip = await JSZip.loadAsync(buf);
  const book = await zip.file('xl/workbook.xml').async('string');
  assert.match(book, /<sheet sheetId="1" name="Lookup" state="hidden"/);
  assert.match(book, /<sheet sheetId="2" name="Report" state="visible"/);
  assert.match(book, /<workbookView [^>]*firstSheet="1" activeTab="1"/);
  assert.deepEqual(show(await sheetFromExcel(buf)), want);
  assert.deepEqual(show(await sheetFromExcel(await excelFromSheet(allHidden))), [['A', false, null], ['B', false, null]]);
});

test('.ods: hidden sheets on their table style (with a tab colour too), the view on the first shown one; never all hidden', async () => {
  const buf = await odsFromSheet(sheet);
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('content.xml').async('string');
  assert.match(xml, /<style:style style:name="ta1" style:family="table"><style:table-properties table:display="false"\/><\/style:style>/);
  assert.match(xml, /<style:style style:name="ta2" style:family="table"><style:table-properties table:display="false" table:tab-color="#757575"\/>/);
  assert.match(xml, /<table:table table:name="Lookup" table:style-name="ta1">/);
  assert.match(xml, /<table:table table:name="Report">/);
  assert.match(await zip.file('settings.xml').async('string'), /<config:config-item config:name="ActiveTable" config:type="string">Report<\/config:config-item>/);
  assert.deepEqual(show(await sheetFromOds(buf)), want);
  assert.deepEqual(show(await sheetFromOds(await odsFromSheet(allHidden))), [['A', false, null], ['B', false, null]]);
});

test('live editing keeps a sheet hidden, and shows it again', () => {
  const doc = sheetDocFromJson(sheet);
  assert.deepEqual(show(jsonFromSheetDoc(doc)), want);
  applySheetJson(doc, { sheets: sheet.sheets.map((s) => ({ ...s, hidden: s.name === 'Report' ? true : undefined })) });
  assert.deepEqual(show(jsonFromSheetDoc(doc)).map(([n, h]) => [n, h]), [['Lookup', false], ['Report', true], ['Old', false]]);
  assert.ok(!('hidden' in jsonFromSheetDoc(doc).sheets[0]));
});

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
test('through LibreOffice: hidden sheets in our .xlsx and .ods, saved again by it in either format, stay hidden', { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-hidden-'));
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as}`))); };
  try {
    fs.writeFileSync(path.join(dir, 's.xlsx'), await excelFromSheet(sheet));
    fs.writeFileSync(path.join(dir, 's.ods'), await odsFromSheet(sheet));
    assert.deepEqual(show(await sheetFromOds(lo('s.xlsx', 'ods', 'a'))), want, '.xlsx saved as .ods');
    assert.deepEqual(show(await sheetFromOds(lo('s.ods', 'ods', 'b'))), want, '.ods saved again as .ods');
    assert.deepEqual(show(await sheetFromExcel(lo('s.ods', 'xlsx', 'c'))), want, '.ods saved as .xlsx');
    assert.deepEqual(show(await sheetFromExcel(lo('s.xlsx', 'xlsx', 'e'))), want, '.xlsx saved again as .xlsx');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
