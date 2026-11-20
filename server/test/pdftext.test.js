// The words in a PDF (Drive search reads PDFs by them): ours read the same as poppler's pdftotext reads them, for PDFs
// made here (documents, sheets, slides; Greek, Cyrillic, Chinese, Japanese, Thai; Hebrew and Arabic in the order
// written) and by reportlab (standard fonts with WinAnsi, an embedded TrueType font with a ToUnicode map).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { textOfPdf } from '../src/office/pdftext.js';
import { pdfFromDoc } from '../src/office/pdfdoc.js';
import { pdfFromSheet } from '../src/office/sheetpdf.js';
import { pdfFromDeck } from '../src/office/slidepdf.js';

const hasPoppler = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0;
const hasReportlab = spawnSync('python3', ['-c', 'import reportlab'], { stdio: 'ignore' }).status === 0;
const words = (s) => new Set(s.replace(/[‪-‮‎‏]/g, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
const same = async (buf, label) => {
  const ours = words(await textOfPdf(buf)), ref = words(execFileSync('pdftotext', ['-', '-'], { input: buf }).toString());
  const missing = [...ref].filter((w) => !ours.has(w)), extra = [...ours].filter((w) => !ref.has(w));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${label}: ${ref.size} words`);
};
const P = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });

test('PDFs made here: the same words as pdftotext', { skip: !hasPoppler && 'poppler isn’t installed here' }, async () => {
  await same(await pdfFromDoc({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Quarterly review' }] },
    P('Revenue rose by 12% to €4.2m — naïve café résumé.'), P('Привет мир, Ελληνικά, 中文报告, 日本語のテキスト, สวัสดี'),
    { type: 'bulletList', content: [{ type: 'listItem', content: [P('First point')] }, { type: 'listItem', content: [P('Second point')] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [P('Cell one')] }, { type: 'tableCell', content: [P('Cell two')] }] }] }] }, 'Doc'), 'a document');
  await same(await pdfFromDoc({ type: 'doc', content: [P('שלום עולם מסמך'), P('مرحبا بالعالم هذا مستند')] }, 'RTL'), 'Hebrew and Arabic');
  await same(await pdfFromSheet({ sheets: [{ name: 'S', cells: { A1: 'Invoice total', B1: '1250', A2: 'Привет', B2: 'Zürich' }, colWidths: {} }] }, 'S'), 'a spreadsheet');
  await same(await pdfFromDeck({ slides: [{ id: 'a', items: [{ id: 't', type: 'text', x: 5, y: 5, w: 90, h: 30, text: 'Launch plan\nNext steps for Q3' }] }] }, 'D'), 'slides');
});

test('PDFs made by reportlab: standard fonts and an embedded TrueType font', { skip: (!hasPoppler && 'poppler isn’t installed here') || (!hasReportlab && 'reportlab isn’t installed here') }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftext-'));
  execFileSync('python3', ['-I', '-W', 'ignore', '-c', `
import os, sys
from reportlab.pdfgen import canvas
d = sys.argv[1]
c = canvas.Canvas(os.path.join(d, 'std.pdf')); c.setFont('Helvetica', 12)
for i, t in enumerate(['Quarterly report for the board', 'Revenue rose by 12% to €4.2m', 'Naïve café: résumé, Zürich']): c.drawString(72, 750 - i * 20, t)
c.showPage(); c.drawString(72, 750, 'Second page words here'); c.save()
f = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
if os.path.exists(f):
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    pdfmetrics.registerFont(TTFont('DV', f))
    c = canvas.Canvas(os.path.join(d, 'ttf.pdf')); c.setFont('DV', 12)
    for i, t in enumerate(['Привет мир отчёт', 'Ελληνικά κείμενο', 'Plain english too']): c.drawString(72, 750 - i * 20, t)
    c.save()`, dir]);
  await same(fs.readFileSync(path.join(dir, 'std.pdf')), 'reportlab, standard fonts');
  if (fs.existsSync(path.join(dir, 'ttf.pdf'))) await same(fs.readFileSync(path.join(dir, 'ttf.pdf')), 'reportlab, DejaVu embedded');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('not a PDF, or one without text: nothing, no error', async () => {
  assert.equal(await textOfPdf(Buffer.from('not a pdf')), '');
  const { PDFDocument } = await import('pdf-lib');
  const d = await PDFDocument.create(); d.addPage();
  assert.equal(await textOfPdf(await d.save()), '');
});
