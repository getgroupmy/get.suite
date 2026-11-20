// Text beyond Western European letters in our PDFs (documents, spreadsheets, presentations): Greek, Cyrillic, Chinese,
// Japanese, Korean, Thai, Tamil, Hindi, symbols and emoji are drawn from the fonts installed on the server (cut down
// to what's drawn) and read back as written by pdftotext and pypdf; before, they all came out as "?". Each script is
// checked where a font for it is installed. (Arabic and Hebrew are left out: drawn left to right, not reordered.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pdfFromDoc } from '../src/office/pdfdoc.js';
import { pdfFromSheet } from '../src/office/sheetpdf.js';
import { pdfFromDeck } from '../src/office/slidepdf.js';
import { installedCovers } from '../src/office/pdffonts.js';
import { parseTtf, subsetTtf } from '../src/office/ttf.js';

const hasPoppler = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0;
const hasPypdf = spawnSync('python3', ['-c', 'import pypdf'], { stdio: 'ignore' }).status === 0;
const LINES = ['Accents: café naïve Zürich', 'Greek: αβγ Δ λόγος', 'Cyrillic: Привет мир', 'Chinese: 中文报告', 'Japanese: 日本語のテキスト', 'Korean: 한국어',
  'Thai: สวัสดี', 'Tamil: வணக்கம்', 'Hindi: नमस्ते', 'Symbols: ≤ ≥ → ✓ ½', 'Emoji: 😀'];
const drawable = LINES.filter((l) => installedCovers(l.replace(/^[^:]+: /, '')));
const T = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });
const flat = (s) => s.replace(/\s+/g, '');
const pdftotext = (buf) => execFileSync('pdftotext', ['-', '-'], { input: buf }).toString();
const pypdf = (buf) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-')), 'a.pdf');
  fs.writeFileSync(f, buf);
  return execFileSync('python3', ['-I', '-W', 'ignore', '-c', 'import sys\nfrom pypdf import PdfReader\nprint("".join(p.extract_text() for p in PdfReader(sys.argv[1]).pages))', f]).toString();
};

test('a document: every script with a font here is drawn and read back; the fonts are cut down to what\'s drawn', { skip: !hasPoppler && 'poppler isn’t installed here' }, async () => {
  assert.ok(drawable.length >= 3, `fonts installed for: ${drawable.join(' / ')}`);
  const doc = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [T('Многоязычный отчёт 報告')] }, ...LINES.map((l, i) => ({ type: 'paragraph', content: [T(l, i % 3 === 1 ? [{ type: 'bold' }] : undefined)] }))] };
  const buf = await pdfFromDoc(doc, 'Scripts');
  const text = pdftotext(buf);
  for (const l of drawable) assert.ok(flat(text).includes(flat(l)), `pdftotext reads “${l}” (got ${text.split('\n').find((x) => x.startsWith(l.split(':')[0])) || 'nothing'})`);
  if (hasPypdf) { const t2 = flat(pypdf(buf)); for (const l of drawable) assert.ok(t2.includes(flat(l)), `pypdf reads “${l}”`); }
  assert.ok(buf.length < 600 * 1024, `${Math.round(buf.length / 1024)} KB: the installed fonts are cut down, not embedded whole`);
  for (const l of LINES.filter((x) => !drawable.includes(x))) assert.ok(flat(text).includes(flat(l.replace(/[^\x00-\xff]/g, '?'))), `no font for “${l}”: ?`);
});

test('a spreadsheet and a presentation: the same', { skip: !hasPoppler && 'poppler isn’t installed here' }, async () => {
  const cells = {}; drawable.forEach((l, i) => { cells[`A${i + 1}`] = l; });
  const sheet = pdftotext(await pdfFromSheet({ sheets: [{ name: 'Sheet1', cells, colWidths: { A: 400 } }] }, 'Scripts'));
  for (const l of drawable) assert.ok(flat(sheet).includes(flat(l)), `sheet: ${l}`);
  const deck = pdftotext(await pdfFromDeck({ slides: [{ id: 's1', items: [{ id: 'e', type: 'text', x: 5, y: 5, w: 90, h: 90, text: drawable.join('\n'), size: 16 }] }] }, 'Scripts'));
  for (const l of drawable) assert.ok(flat(deck).includes(flat(l)), `slides: ${l}`);
});

test('the subsetter: a font cut down to some glyphs keeps those glyphs and their widths, and is a valid TrueType file', () => {
  const file = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((f) => fs.existsSync(f));
  if (!file) return; // (DejaVu isn't installed here)
  const f = parseTtf(fs.readFileSync(file));
  const ids = [...'Ωж✓'].map((ch) => f.map.get(ch.codePointAt(0)));
  assert.ok(ids.every((g) => g > 0));
  const sub = parseTtf(subsetTtf(f, ids));
  assert.equal(sub.numGlyphs, f.numGlyphs, 'glyph numbers stay the same');
  for (const g of ids) {
    assert.equal(sub.advance(g), f.advance(g));
    assert.ok(sub.locaAt(g + 1) > sub.locaAt(g), 'the glyph is there');
  }
  assert.equal(sub.locaAt(f.map.get(65) + 1) - sub.locaAt(f.map.get(65)), 0, 'one not asked for is empty');
  assert.ok(subsetTtf(f, ids).length < fs.statSync(file).size / 4);
});

test('right to left: Hebrew and Arabic words read back as written (letters in order, Arabic joined forms copy as letters)', { skip: !hasPoppler && 'poppler isn’t installed here' }, async () => {
  const words = ['שלום', 'עולם', 'מסמך', 'مرحبا', 'بالعالم', 'التقرير', 'السنوي'].filter((w) => installedCovers(w));
  if (!words.length) return;
  const P = (t) => ({ type: 'paragraph', content: [T(t)] });
  const read = (buf) => pdftotext(buf).replace(/[‪-‮‎‏]/g, '');
  const docText = read(await pdfFromDoc({ type: 'doc', content: [P('שלום עולם, זה מסמך.'), P('مرحبا بالعالم'), P('التقرير السنوي لعام 2026'), P('The word שלום here.')] }, 'RTL'));
  for (const w of words) assert.ok(docText.includes(w), `the document has “${w}” (got ${docText.replace(/\n+/g, ' / ')})`);
  assert.ok(docText.includes('2026'), 'a number in Arabic text keeps its digits in order');
  const sheetText = read(await pdfFromSheet({ sheets: [{ name: 'S', cells: { A1: 'שלום עולם', A2: 'مرحبا بالعالم' }, colWidths: { A: 300 } }] }, 'RTL'));
  for (const w of words.filter((x) => /שלום|עולם|مرحبا|بالعالم/.test(x))) assert.ok(sheetText.includes(w), `the spreadsheet has “${w}”`);
});

test('bidi: Arabic letters joined, right-to-left runs reversed, numbers and brackets kept the right way round', async () => {
  const { visual, shapeArabic } = await import('../src/office/bidi.js');
  const hex = (s) => [...s].map((c) => c.codePointAt(0).toString(16)).join(' ');
  assert.equal(hex(shapeArabic('مرحبا')), 'fee3 feae fea3 fe92 fe8e', 'initial meem, final ra (which doesn\'t join on), initial hah, medial beh, final alef');
  assert.equal(hex(shapeArabic('لا')), 'fefb', 'lam-alef');
  assert.equal(visual('שלום עולם'), 'םלוע םולש');
  assert.equal(visual('עמוד 12'), '12 דומע', 'a number stays as written, on the left of a right-to-left line');
  assert.equal(visual('הערה (חשוב)'), '(בושח) הרעה', 'brackets mirrored');
  assert.equal(visual('Mixed שלום here'), 'Mixed םולש here', 'a Hebrew word in an English line');
});
