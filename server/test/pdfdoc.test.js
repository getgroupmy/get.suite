import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { pdfFromDoc } from '../src/office/pdfdoc.js';
import { installedCovers } from '../src/office/pdffonts.js';

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
  assert.equal(String(pdf.catalog.get(PDFName.of('Lang'))), '(en)');
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
  // what the standard fonts can't draw comes from an installed font that has it (here, Chinese/Japanese); "?" without one
  assert.match(text, installedCovers('日本') ? /Bold café € 日本 the site\[1\]/ : /Bold café € \?\? the site\[1\]/);
  assert.match(text, /Item\s+Cost/);
  assert.match(text, /\[Missing picture\]/);
  assert.match(text, /Last page \\frac\{1\}\{2\}/);
  assert.match(text, /1\. A note\./);
  assert.match(text, /Confidential\s+1/);
});

test('the PDF follows the document\'s look: its font, sizes, colours and highlights, spacing and indents, page colour and watermark', async () => {
  const S = (text, ...marks) => ({ type: 'text', text, marks });
  const d = { type: 'doc', content: [
    { type: 'paragraph', content: [S('Red', { type: 'textStyle', attrs: { color: '#d93025' } }), { type: 'text', text: ' and ' }, S('lit', { type: 'highlight', attrs: { color: '#fff475' } }), { type: 'text', text: ' and ' }, S('big', { type: 'textStyle', attrs: { fontSize: '20pt' } })] },
    { type: 'paragraph', attrs: { indent: 2, spaceBefore: 24, lineHeight: '2' }, content: [{ type: 'text', text: 'Indented twice.' }] },
  ] };
  const buf = await pdfFromDoc(d, 'Styled', { setup: { font: 'Georgia', fontSize: 12, watermark: 'DRAFT', pageColor: '#fef7e0' } });
  assert.equal((await PDFDocument.load(buf)).getPageCount(), 1);
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdfstyle-')), 'a.pdf');
  fs.writeFileSync(f, buf);
  let fonts, text, bbox;
  try { fonts = execFileSync('pdffonts', [f]).toString(); text = execFileSync('pdftotext', [f, '-']).toString(); bbox = execFileSync('pdftotext', ['-bbox', f, '-']).toString(); } catch { return; } // (poppler not installed)
  assert.match(fonts, /Times-Roman/, 'a serif document in Times');
  assert.doesNotMatch(fonts, /Helvetica/);
  assert.match(text, /Red and lit and\s+big/);
  assert.match(text.replace(/\s+/g, ''), /DRAFT/); // (drawn across the page)
  // The indented paragraph starts two half-inch steps (72pt) further right than the first.
  const xOf = (word) => Number(new RegExp(`xMin="([\\d.]+)"[^>]*>${word}<`).exec(bbox)?.[1]);
  assert.ok(Math.abs(xOf('Indented') - xOf('Red') - 72) < 1, `${xOf('Indented')} vs ${xOf('Red')}`);
  // "big" is drawn taller than "and".
  const hOf = (word) => { const m = new RegExp(`yMin="([\\d.]+)" xMax="[\\d.]+" yMax="([\\d.]+)">${word}<`).exec(bbox); return m ? Number(m[2]) - Number(m[1]) : 0; };
  assert.ok(hOf('big') > hOf('and') * 1.4, `${hOf('big')} vs ${hOf('and')}`);
});

test('the PDF has bookmarks from the headings, and the table of contents lists them with their pages, as links', async () => {
  const T = (t) => ({ type: 'text', text: t });
  const H = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [T(t)] });
  const P = (t) => ({ type: 'paragraph', content: [T(t)] });
  const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. '.repeat(6);
  const d = { type: 'doc', content: [{ type: 'tableOfContents' }, H(1, 'Introduction'), P(long), H(2, 'Scope'), ...Array(8).fill(P(long)), H(1, 'Costs'), H(3, 'Deep'), H(2, 'Travel'), ...Array(8).fill(P(long)), H(1, 'Summary — 日本'), P('End.')] };
  const buf = await pdfFromDoc(d, 'Handbook');
  const pdf = await PDFDocument.load(buf);
  const titles = [];
  const pageOf = new Map(pdf.getPages().map((p, i) => [p.ref.toString(), i + 1]));
  const walk = (ref, depth) => { for (let r = ref; r;) { const n = pdf.context.lookup(r); titles.push(`${'-'.repeat(depth)}${n.lookup(PDFName.of('Title')).decodeText()}@${pageOf.get(n.lookup(PDFName.of('Dest')).get(0).toString())}`); const f = n.get(PDFName.of('First')); if (f) walk(f, depth + 1); r = n.get(PDFName.of('Next')); } };
  walk(pdf.catalog.lookup(PDFName.of('Outlines')).get(PDFName.of('First')), 0);
  assert.deepEqual(titles.map((t) => t.replace(/@\d+$/, '')), ['Introduction', '-Scope', 'Costs', '-Deep', '-Travel', 'Summary — 日本'], 'nested by level (bookmarks keep any characters) (a level 3 under a level 1 goes under it)');
  assert.equal(String(pdf.catalog.get(PDFName.of('PageMode'))), '/UseOutlines');
  // The contents' links go where the bookmarks do; its page numbers are those pages.
  const annots = pdf.getPage(0).node.lookup(PDFName.of('Annots'));
  const linked = Array.from({ length: annots.size() }, (_, i) => pageOf.get(pdf.context.lookup(annots.get(i)).lookup(PDFName.of('Dest')).get(0).toString()));
  assert.deepEqual(linked, titles.map((t) => Number(t.split('@')[1])));
  const { execFileSync } = await import('node:child_process');
  let text;
  try { text = execFileSync('pdftotext', ['-layout', '-l', '1', '-', '-'], { input: buf }).toString(); } catch { return; }
  titles.forEach((t) => { const [name, pg] = t.replace(/^-+/, '').split('@'); const shown = installedCovers(name) ? name : name.replace(/[^\x00-\xff—]/g, '?'); assert.match(text, new RegExp(`${shown.replace(/\?/g, '\\?')} \\.+ ${pg}\\n`), `${name} on page ${pg}`); }); // (drawn: what no font here has is ?)
});

test('words are placed as drawn: no space lost after letter pairs that kern (y, AV, To)', async () => {
  const buf = await pdfFromDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Date: ', marks: [{ type: 'bold' }] }, { type: 'text', text: 'Tuesday, 17 November. AVAWAY To Yo' }] }] });
  const { execFileSync } = await import('node:child_process');
  let text;
  try { text = execFileSync('pdftotext', ['-', '-'], { input: buf }).toString(); } catch { return; }
  assert.match(text, /Date: Tuesday, 17 November\. AVAWAY To Yo/);
});
