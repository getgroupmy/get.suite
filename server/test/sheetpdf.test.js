import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { pdfFromSheet } from '../src/office/sheetpdf.js';

test('a spreadsheet as a PDF: values worked out and formatted, frozen rows on every page, hidden columns left out, a page group per sheet', async () => {
  const cells = { A1: 'Item', B1: 'Qty', C1: 'Price', D1: 'Total', E1: 'Secret column' };
  for (let r = 2; r <= 60; r++) Object.assign(cells, { [`A${r}`]: `Item ${r - 1}`, [`B${r}`]: String(r), [`C${r}`]: '2.5', [`D${r}`]: `=B${r}*C${r}` });
  Object.assign(cells, { A62: 'Sum', D62: '=SUM(D2:D60)', B62: '=Other!A1*2', C62: '=1/0' });
  const formats = { A1: { b: true, fill: '#e8f0fe' }, D62: { b: true, num: 'currency', cur: 'USD', bd: 'tb' } };
  const data = { sheets: [{ name: 'Orders', cells, formats, frozen: { rows: 1 }, hide: { cols: [4] } }, { name: 'Other', cells: { A1: '21' } }, { name: 'Gone', hidden: true, cells: { A1: 'Hidden sheet' } }] };
  const buf = await pdfFromSheet(data, 'Orders book', { author: 'Olivia Owner' });
  const pdf = await PDFDocument.load(buf);
  assert.equal(pdf.getTitle(), 'Orders book');
  assert.equal(pdf.getAuthor(), 'Olivia Owner');
  assert.equal(pdf.getPageCount(), 3, 'two pages of orders, one of the other sheet; the hidden sheet left out');
  assert.deepEqual([Math.round(pdf.getPage(0).getWidth()), Math.round(pdf.getPage(0).getHeight())], [842, 595], 'A4 landscape');
  assert.equal((await PDFDocument.load(await pdfFromSheet({ sheets: [] }))).getPageCount(), 1);
  const { execFileSync } = await import('node:child_process');
  let text;
  try { text = execFileSync('pdftotext', ['-layout', '-', '-'], { input: buf }).toString(); } catch { return; }
  const pages = text.split('\f');
  assert.match(pages[0], /Orders book — Orders[\s\S]*Item\s+Qty\s+Price\s+Total[\s\S]*Item 1\s+2\s+2\.5\s+5\n/);
  assert.match(pages[1], /Item\s+Qty\s+Price\s+Total/, 'the frozen row again at the top');
  assert.match(pages[1], /Sum\s+42\s+#DIV\/0!\s+\$4,572\.50/, 'another sheet, an error, a currency');
  assert.doesNotMatch(text, /Secret column|Hidden sheet/);
  assert.match(pages[2], /Orders book — Other[\s\S]*21/);
});
