// Random presentations (text boxes with several lines, tabs, two spaces, a space first, emoji, Hebrew and <&>; sizes, bold,
// italic, underline, alignment, colours; shapes with words, fills and turns; speaker notes) through our .pptx and .odp and
// back, and through LibreOffice. The test found underline missing from Slides altogether (a deck could have it from
// nowhere; it's a button now, in both files and the PDF), and speaker notes and words in an .odp losing a space they start
// with, and runs of spaces once LibreOffice had saved the file (written as ODF's own <text:s/> now).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { PDFDocument, PDFName, PDFArray } from 'pdf-lib';
import { soffice, hasSoffice } from './soffice.js';
import { odpFromDeck, deckFromOdp } from '../src/office/odp.js';
import { powerPointFromDeck, deckFromPowerPoint } from '../src/office/powerpoint.js';
import { pdfFromDeck } from '../src/office/slidepdf.js';

function decks(n, start) {
  let seed = start; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const WORDS = ['alpha', 'Ωmega', 'naïve', 'x<y', 'a&b', '"q"', "it's", '中文', 'שלום', '😀', 'two  spaces', 'tab\there', '1,234', '<tag>', '  lead'];
  const text = () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(WORDS)).join(' ')).join('\n');
  const item = (k) => {
    const base = { id: `i${k}`, x: Math.round(rnd() * 60), y: Math.round(rnd() * 60), w: 10 + Math.round(rnd() * 30), h: 5 + Math.round(rnd() * 20) };
    if (rnd() < 0.7) return { ...base, type: 'text', text: text(), size: pick([14, 18, 24, 32, 44]), ...(rnd() < 0.3 && { bold: true }), ...(rnd() < 0.3 && { italic: true }), ...(rnd() < 0.2 && { underline: true }), ...(rnd() < 0.3 && { align: pick(['center', 'right']) }), ...(rnd() < 0.3 && { color: pick(['#d93025', '#1a73e8', '#188038']) }) };
    return { ...base, type: 'shape', shape: pick(['rect', 'ellipse', 'star', 'triangle']), fill: pick(['#ffd666', '#a142f4', '#ffffff']), ...(rnd() < 0.5 && { text: pick(WORDS) }), ...(rnd() < 0.3 && { rot: pick([15, 45, 90]) }) };
  };
  return Array.from({ length: n }, () => ({ theme: 'light', slides: Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, s) => ({ id: `s${s}`, ...(rnd() < 0.5 && { notes: text() }), items: Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, k) => item(k)) })) }));
}
// What a slide keeps of each item. Defaults come back written out (a shape's words 20 and centred in the background
// colour, a text box's in the text colour): left out on both sides.
const keep = ['type', 'text', 'size', 'bold', 'italic', 'underline', 'align', 'color', 'shape', 'fill', 'rot', 'x', 'y', 'w', 'h'];
const DEFAULTS = { shape: { size: 20, align: 'center', color: '#ffffff' }, text: { color: '#202124', align: 'left' } };
const view = (d) => d.slides.map((s) => ({ notes: s.notes || '', items: (s.items || []).map((it) => Object.fromEntries(keep
  .filter((k) => it[k] !== undefined && it[k] !== false && DEFAULTS[it.type]?.[k] !== it[k])
  .map((k) => [k, typeof it[k] === 'number' ? Math.round(it[k]) : it[k]]))) }));
const differences = (want, got) => {
  const out = [];
  view(want).forEach((s, i) => {
    const t = view(got)[i] || { notes: '', items: [] };
    if (s.notes !== t.notes) out.push(`slide ${i + 1} notes ${JSON.stringify(s.notes)} came back ${JSON.stringify(t.notes)}`);
    s.items.forEach((it, j) => {
      const u = t.items[j] || {};
      for (const k of new Set([...Object.keys(it), ...Object.keys(u)])) {
        if (JSON.stringify(it[k]) !== JSON.stringify(u[k]) && !(['x', 'y', 'w', 'h'].includes(k) && Math.abs((it[k] || 0) - (u[k] || 0)) <= 1)) out.push(`slide ${i + 1} item ${j + 1} ${k} ${JSON.stringify(it[k])} came back ${JSON.stringify(u[k])}`);
      }
    });
  });
  return out;
};
const FORMATS = [['pptx', powerPointFromDeck, deckFromPowerPoint], ['odp', odpFromDeck, deckFromOdp]];
const savePicture = async () => 'p';

test('20 random presentations through .pptx and .odp and back: words, looks and notes kept', async () => {
  for (const [name, to, from] of FORMATS) {
    const wrong = [];
    for (const [k, d] of decks(20, 1).entries()) { const back = await from(await to(d, {}), { savePicture }); wrong.push(...differences(d, back.deck || back).map((m) => `#${k} ${m}`)); }
    assert.deepEqual(wrong, [], name);
  }
});

test('and 20 through LibreOffice, saved again by it as .pptx and as .odp', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const list = decks(20, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckroundtrip-'));
  try {
    for (const [name, to, from] of FORMATS) {
      fs.mkdirSync(path.join(dir, name, 'out'), { recursive: true });
      const files = [];
      for (const [k, d] of list.entries()) { files.push(path.join(dir, name, `d${k}.${name}`)); fs.writeFileSync(files.at(-1), await to(d, {})); }
      soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', name, '--outdir', path.join(dir, name, 'out'), ...files]);
      const wrong = [];
      for (const [k, d] of list.entries()) { const back = await from(fs.readFileSync(path.join(dir, name, 'out', `d${k}.${name}`)), { savePicture }); wrong.push(...differences(d, back.deck || back).map((m) => `#${k} ${m}`)); }
      assert.deepEqual(wrong, [], name);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('underlined words get a line under them in the PDF', async () => {
  const deck = (underline) => ({ slides: [{ id: 'a', items: [{ id: 't', type: 'text', x: 10, y: 10, w: 80, h: 20, text: 'Underlined', size: 40, underline }] }] });
  // (the page's drawing, unpacked: each content stream of the first page)
  const lines = async (d) => {
    const pdf = await PDFDocument.load(await pdfFromDeck(d), { updateMetadata: false });
    const c = pdf.context.lookup(pdf.getPage(0).node.get(PDFName.of('Contents')));
    const streams = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r)) : [c];
    return streams.map((st) => { const b = Buffer.from(st.getContents()); try { return zlib.inflateSync(b).toString('latin1'); } catch { return b.toString('latin1'); } }).join('\n');
  };
  const plain = await lines(deck(false)), under = await lines(deck(true));
  assert.ok((under.match(/ l\b/g) || []).length > (plain.match(/ l\b/g) || []).length, 'a line drawn');
});
