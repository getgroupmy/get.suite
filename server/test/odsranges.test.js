// Named ranges and grouped rows and columns in .ods files, both ways, as LibreOffice writes them, and through it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { odsFromSheet, sheetFromOds } from '../src/office/ods.js';
import { excelFromSheet, sheetFromExcel } from '../src/office/excel.js';

const sheet = { sheets: [
  { name: 'Sales', cells: { A1: 'Item', A2: '5', A3: '7', A4: '9', B1: '=SUM(Amounts)', B2: '=Rate*2', C1: '=SUM(Totals)' }, names: { Amounts: 'A2:A4', Rate: 'A2' },
    groups: [{ axis: 'row', from: 1, to: 2, collapsed: false }, { axis: 'col', from: 3, to: 4, collapsed: true }], hide: { rows: [6] } },
  { name: 'Other sheet', cells: { A1: '1', A2: '2' }, names: { Totals: 'A1:A2' } },
] };
// Comparable: names, groups in one order, hidden rows and columns, and the formulas.
const show = (d) => d.sheets.map((s) => ({ names: s.names, groups: [...(s.groups || [])].sort((a, b) => a.axis.localeCompare(b.axis) || a.from - b.from), hide: s.hide || null, B1: s.cells.B1 }));
const want = show(sheet);

test('.ods out: named ranges as named expressions, groups as row and column groups (a collapsed one hidden)', async () => {
  const xml = await (await JSZip.loadAsync(await odsFromSheet(sheet))).file('content.xml').async('string');
  assert.match(xml, /<\/table:table><table:named-expressions><table:named-range table:name="Amounts" table:base-cell-address="\$Sales\.\$A\$1" table:cell-range-address="\$Sales\.\$A\$2:\.\$A\$4"\/><table:named-range table:name="Rate" [^>]*table:cell-range-address="\$Sales\.\$A\$2"\/><table:named-range table:name="Totals" [^>]*table:cell-range-address="\$'Other sheet'\.\$A\$1:\.\$A\$2"\/><\/table:named-expressions>/);
  assert.match(xml, /<table:table-column-group table:display="false"><table:table-column [^>]*table:visibility="collapse"[^>]*\/><table:table-column [^>]*table:visibility="collapse"[^>]*\/><\/table:table-column-group>/);
  assert.match(xml, /<table:table-row-group><table:table-row>(?:(?!<\/table:table-row-group>).)*<\/table:table-row><table:table-row>(?:(?!<\/table:table-row-group>).)*<\/table:table-row><\/table:table-row-group>/);
  assert.equal((xml.match(/<table:table-row-group/g) || []).length, 1);
});

test('.ods in: what went out comes back; a group LibreOffice shows folded, or with all its rows hidden, is collapsed', async () => {
  assert.deepEqual(show(await sheetFromOds(await odsFromSheet(sheet))), want);
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
  const row = (t, attrs = '') => `<table:table-row${attrs}><table:table-cell office:value-type="string"><text:p>${t}</text:p></table:table-cell></table:table-row>`;
  zip.file('content.xml', `<office:document-content ${NS}><office:body><office:spreadsheet><table:table table:name="S">
    <table:table-column/>${row('a')}<table:table-row-group>${row('b', ' table:visibility="collapse"')}${row('c', ' table:visibility="collapse"')}</table:table-row-group>${row('d')}<table:table-row-group>${row('e')}<table:table-row-group>${row('f')}</table:table-row-group></table:table-row-group>${row('g', ' table:visibility="collapse"')}
  </table:table><table:named-expressions><table:named-range table:name="Lst" table:cell-range-address="$S.$A$1:.$A$4"/><table:named-range table:name="A1" table:cell-range-address="$S.$A$1"/><table:named-range table:name="Elsewhere" table:cell-range-address="$Nope.$A$1"/></table:named-expressions></office:spreadsheet></office:body></office:document-content>`);
  const [s] = (await sheetFromOds(await zip.generateAsync({ type: 'nodebuffer' }))).sheets;
  assert.deepEqual(s.groups, [{ axis: 'row', from: 1, to: 2, collapsed: true }, { axis: 'row', from: 4, to: 5, collapsed: false }], 'the outer group of nested ones');
  assert.deepEqual(s.hide, { rows: [6] }, 'rows a collapsed group hides are the group\'s; one hidden by hand stays hidden');
  assert.deepEqual(s.names, { Lst: 'A1:A4' }, 'not a name that is a cell, nor one on a sheet that isn\'t there');
});

test('.ods: the file has one set of names, so a name two sheets use goes in once (the first sheet\'s)', async () => {
  const buf = await odsFromSheet({ sheets: [{ name: 'A', cells: { A1: '1' }, names: { Total: 'A1' } }, { name: 'B', cells: { A1: '2' }, names: { total: 'A1', Other: 'A1' } }] });
  const xml = await (await JSZip.loadAsync(buf)).file('content.xml').async('string');
  assert.equal((xml.match(/<table:named-range /g) || []).length, 2);
  assert.deepEqual((await sheetFromOds(buf)).sheets.map((s) => s.names), [{ Total: 'A1' }, { Other: 'A1' }]);
});

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
test('through LibreOffice: formulas using named ranges are worked out there, and names and groups come back, .ods and .xlsx each way', { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-odsnames-'));
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as}`))); };
  try {
    fs.writeFileSync(path.join(dir, 's.ods'), await odsFromSheet(sheet));
    fs.writeFileSync(path.join(dir, 's.xlsx'), await excelFromSheet(sheet));
    assert.equal(lo('s.ods', 'csv', 'v').toString().split('\n')[0], 'Item,21,3', 'SUM(Amounts) and SUM(Totals), not #NAME?');
    assert.deepEqual(show(await sheetFromOds(lo('s.ods', 'ods', 'a'))), want, '.ods saved again as .ods');
    assert.deepEqual(show(await sheetFromExcel(lo('s.ods', 'xlsx', 'b'))), want, '.ods saved as .xlsx');
    assert.deepEqual(show(await sheetFromOds(lo('s.xlsx', 'ods', 'c'))), want, '.xlsx saved as .ods');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
