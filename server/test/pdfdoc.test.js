import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { pdfFromDoc } from '../src/office/pdfdoc.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const T = (text, ...m) => ({ type: 'text', text, ...(m.length && { marks: m.map((x) => (typeof x === 'string' ? { type: x } : x)) }) });
const P = (...c) => ({ type: 'paragraph', content: c });
const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. ';
const doc = { type: 'doc', content: [
  { type: 'heading', attrs: { level: 1 }, content: [T('Plan for 2027')] },
  P(T('Bold', 'bold'), T(' café € 日本 '), T('the site', { type: 'link', attrs: { href: 'https://acme.example/' } }), { type: 'footnote', attrs: { note: 'A note.' } }),
  ...Array.from({ length: 30 }, () => P(T(long.repeat(3)))),
  { type: 'bulletList', content: [{ type: 'listItem', content: [P(T('One'))] }] },
  { type: 'image', attrs: { fileId: 'p1', alt: 'Dot', width: 100 } },
  { type: 'image', attrs: { fileId: 'gone', alt: 'Missing picture' } },
  { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [P(T('Item'))] }, { type: 'tableHeader', content: [P(T('Cost'))] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [P(T('Taxi'))] }, { type: 'tableCell', content: [P(T('12'))] }] }] },
  { type: 'pageBreak' },
  P(T('Last page '), { type: 'math', attrs: { latex: '\\frac{1}{2}' } }),
] };

test('a document as a PDF: the page setup\'s paper and orientation, pages as the text needs, clickable links, pictures', async () => {
  const buf = await pdfFromDoc(doc, 'Plan', { pictureData: async (id) => (id === 'p1' ? { data: PNG, mime: 'image/png' } : null), setup: { size: 'letter', orientation: 'landscape', margin: 'narrow', footer: 'Confidential', numbers: true } });
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  const pdf = await PDFDocument.load(buf);
  assert.equal(pdf.getTitle(), 'Plan');
  const pages = pdf.getPages();
  assert.ok(pages.length >= 3, `${pages.length} pages`);
  const round = ({ width, height }) => ({ width: Math.round(width), height: Math.round(height) });
  assert.deepEqual(round(pages[0].getSize()), { width: 792, height: 612 }, 'Letter, landscape');
  const links = pages[0].node.lookup(PDFName.of('Annots'));
  assert.ok(links && links.size() === 1, 'the link is clickable');
  assert.match(String(pdf.context.lookup(links.get(0)).lookup(PDFName.of('A')).lookup(PDFName.of('URI'))), /acme\.example/);
  // A4 portrait by default
  const plain = await PDFDocument.load(await pdfFromDoc({ type: 'doc', content: [P(T('Hi'))] }, 'Hi'));
  assert.deepEqual(plain.getPages().map((p) => round(p.getSize())), [{ width: 595, height: 842 }], 'A4 portrait');
  assert.equal((await PDFDocument.load(await pdfFromDoc({ type: 'doc', content: [] }))).getPageCount(), 1);
  // The words, where pdftotext is installed to read them back.
  const { execFileSync } = await import('node:child_process');
  let text;
  try { text = execFileSync('pdftotext', ['-layout', '-', '-'], { input: buf }).toString(); } catch { return; }
  assert.match(text, /Plan for 2027/);
  assert.match(text, /Bold café € \?\? the site\[1\]/, 'what the standard fonts can\'t draw is a ?');
  assert.match(text, /Item\s+Cost/);
  assert.match(text, /\[Missing picture\]/);
  assert.match(text, /Last page \\frac\{1\}\{2\}/);
  assert.match(text, /1\. A note\./);
  assert.match(text, /Confidential\s+1/);
});
