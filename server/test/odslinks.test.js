// Link cells in .ods files (LibreOffice's Insert → Hyperlink, or an Excel file's links it kept) open as links, as
// =HYPERLINK(…), the way an Excel file's do; HYPERLINK formulas go out and come back, also through LibreOffice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { odsFromSheet, sheetFromOds } from '../src/office/ods.js';
import { sheetFromExcel } from '../src/office/excel.js';

const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"';
const odsOf = async (rows) => {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
  zip.file('content.xml', `<office:document-content ${NS}><office:body><office:spreadsheet><table:table table:name="S"><table:table-column/>${rows.map((p) => `<table:table-row><table:table-cell office:value-type="string"><text:p>${p}</text:p></table:table-cell></table:table-row>`).join('')}</table:table></office:spreadsheet></office:body></office:document-content>`);
  return zip.generateAsync({ type: 'nodebuffer' });
};

test('.ods in: a cell that is one link to a web page or an email address is a link; anything else stays its text', async () => {
  const { cells } = (await sheetFromOds(await odsOf([
    '<text:a xlink:href="https://acme.example/" xlink:type="simple">Our site</text:a>',
    '<text:a xlink:href="mailto:hi@acme.example">Mail us</text:a>',
    '<text:span><text:a xlink:href="https://acme.example/">https://acme.example/</text:a></text:span>',
    'Read <text:a xlink:href="https://acme.example/">this</text:a> first',
    '<text:a xlink:href="#Other.A1">Go to Other</text:a>',
    '<text:a xlink:href="javascript:alert(1)">Click</text:a>',
    '<text:a xlink:href="https://a.example/">A</text:a><text:a xlink:href="https://b.example/">B</text:a>',
    'Say "hi" <text:a xlink:href="https://x.example/?q=&quot;1&quot;">here</text:a>',
  ]))).sheets[0];
  assert.deepEqual(cells, {
    A1: '=HYPERLINK("https://acme.example/", "Our site")',
    A2: '=HYPERLINK("mailto:hi@acme.example", "Mail us")',
    A3: '=HYPERLINK("https://acme.example/")',
    A4: 'Read this first', // a link in the middle of the words: the words
    A5: 'Go to Other', // a place inside the file: its text
    A6: 'Click',
    A7: 'AB',
    A8: 'Say "hi" here',
  });
});

test('.ods: HYPERLINK formulas go out and come back as they were', async () => {
  const cells = { A1: '=HYPERLINK("https://acme.example/","Our site")', A2: '=HYPERLINK("mailto:hi@acme.example")' };
  assert.deepEqual((await sheetFromOds(await odsFromSheet({ sheets: [{ name: 'S', cells }] }))).sheets[0].cells, cells);
});

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
test('through LibreOffice: an Excel file\'s link cells saved as .ods, and our links saved again, open as links', { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
  const ExcelJS = createRequire(import.meta.url)('exceljs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-odslinks-'));
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as}`))); };
  try {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = { text: 'Our site', hyperlink: 'https://acme.example/' };
    ws.getCell('A2').value = { text: 'Mail us', hyperlink: 'mailto:hi@acme.example' };
    ws.getCell('A3').value = 'plain';
    fs.writeFileSync(path.join(dir, 'l.xlsx'), Buffer.from(await wb.xlsx.writeBuffer()));
    const want = (await sheetFromExcel(fs.readFileSync(path.join(dir, 'l.xlsx')))).sheets[0].cells;
    assert.equal(want.A1, '=HYPERLINK("https://acme.example/", "Our site")');
    assert.deepEqual((await sheetFromOds(lo('l.xlsx', 'ods', 'a'))).sheets[0].cells, want, 'the same as from the Excel file');
    const cells = { A1: '=HYPERLINK("https://acme.example/","Our site")' };
    fs.writeFileSync(path.join(dir, 'h.ods'), await odsFromSheet({ sheets: [{ name: 'S', cells }] }));
    assert.deepEqual((await sheetFromOds(lo('h.ods', 'ods', 'b'))).sheets[0].cells, cells);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
