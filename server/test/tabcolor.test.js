// A sheet's tab colour in Excel and OpenDocument files, both ways, as each keeps it, and through LibreOffice.
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

const sheet = { sheets: [{ name: 'Budget', tabColor: '#e53935', cells: { A1: '1' } }, { name: 'Notes', cells: { A1: 'x' } }, { name: 'Plan', tabColor: '#1E88E5', cells: { A1: '2' } }, { name: 'Odd', tabColor: 'red', cells: {} }] };
const show = (d) => d.sheets.map((s) => [s.name, s.tabColor || null]);
const want = [['Budget', '#e53935'], ['Notes', null], ['Plan', '#1e88e5'], ['Odd', null]];

test('.xlsx: a tab colour as Excel\'s (a colour that isn\'t one is left out), and back', async () => {
  const buf = await excelFromSheet(sheet);
  const zip = await JSZip.loadAsync(buf);
  assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'), /<sheetPr><tabColor rgb="FFE53935"\/>/);
  assert.doesNotMatch(await zip.file('xl/worksheets/sheet2.xml').async('string'), /tabColor/);
  assert.doesNotMatch(await zip.file('xl/worksheets/sheet4.xml').async('string'), /tabColor/);
  assert.deepEqual(show(await sheetFromExcel(buf)), want);
});

test('.ods: a tab colour on the sheet\'s own table style, as LibreOffice keeps it (also its older name), and back', async () => {
  const buf = await odsFromSheet(sheet);
  const xml = await (await JSZip.loadAsync(buf)).file('content.xml').async('string');
  assert.match(xml, /<style:style style:name="ta1" style:family="table"><style:table-properties table:display="true" table:tab-color="#e53935"\/><\/style:style>/);
  assert.match(xml, /<table:table table:name="Budget" table:style-name="ta1">/);
  assert.match(xml, /<table:table table:name="Notes">/);
  assert.match(xml, /<table:table table:name="Plan" table:style-name="ta2">/);
  assert.deepEqual(show(await sheetFromOds(buf)), want);
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:tableooo="http://openoffice.org/2009/table"';
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
  zip.file('content.xml', `<office:document-content ${NS}><office:automatic-styles><style:style style:name="t" style:family="table"><style:table-properties tableooo:tab-color="#43A047"/></style:style></office:automatic-styles><office:body><office:spreadsheet><table:table table:name="Old" table:style-name="t"><table:table-column/><table:table-row><table:table-cell/></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`);
  assert.deepEqual(show(await sheetFromOds(await zip.generateAsync({ type: 'nodebuffer' }))), [['Old', '#43a047']]);
});

test('live editing keeps a tab colour: set, changed and taken away, the other sheets untouched', () => {
  const doc = sheetDocFromJson({ sheets: [{ name: 'A', tabColor: '#e53935', cells: {} }, { name: 'B', cells: {} }] });
  assert.deepEqual(jsonFromSheetDoc(doc).sheets.map((s) => s.tabColor ?? null), ['#e53935', null]);
  applySheetJson(doc, { sheets: [{ name: 'A', tabColor: '#1e88e5', cells: {} }, { name: 'B', tabColor: '#43a047', cells: {} }] });
  assert.deepEqual(jsonFromSheetDoc(doc).sheets.map((s) => s.tabColor ?? null), ['#1e88e5', '#43a047']);
  applySheetJson(doc, { sheets: [{ name: 'A', cells: {} }, { name: 'B', tabColor: '#43a047', cells: {} }] });
  assert.deepEqual(jsonFromSheetDoc(doc).sheets.map((s) => s.tabColor ?? null), [null, '#43a047']);
  assert.ok(!('tabColor' in jsonFromSheetDoc(doc).sheets[0]));
});

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
test('through LibreOffice: tab colours in our .xlsx and .ods, saved again by it in either format, come back', { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-tabcolor-'));
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
