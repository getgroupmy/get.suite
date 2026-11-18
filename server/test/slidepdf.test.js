import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { pdfFromDeck } from '../src/office/slidepdf.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
test('a presentation as a PDF: a 16:9 page a slide, skipped ones left out, its words, tables, charts and numbers', async () => {
  const deck = { theme: 'light', numbers: 'skip-first', slides: [
    { id: 'a', items: [{ id: 't', type: 'text', role: 'title', x: 10, y: 30, w: 80, h: 20, text: 'Quarterly review', size: 54, bold: true, align: 'center' }] },
    { id: 'b', skip: true, items: [{ id: 'x', type: 'text', x: 5, y: 5, w: 90, h: 10, text: 'Hidden slide' }] },
    { id: 'c', items: [
      { id: 'b2', type: 'text', x: 5, y: 20, w: 45, h: 40, text: '• Hire two people\n• Open the shop 日本', size: 22 },
      { id: 's1', type: 'shape', shape: 'ellipse', x: 60, y: 20, w: 15, h: 20, fill: '#ff0000', text: 'Go' },
      { id: 's2', type: 'shape', shape: 'star', x: 80, y: 20, w: 15, h: 20 },
      { id: 'l', type: 'shape', shape: 'arrow', dir: 'u', x: 5, y: 65, w: 40, h: 4 },
      { id: 'i', type: 'image', fileId: 'p', x: 5, y: 72, w: 10, h: 15 },
      { id: 'i2', type: 'image', fileId: 'gone', alt: 'Team photo', x: 5, y: 88, w: 20, h: 10 },
      { id: 'tb', type: 'table', x: 20, y: 70, w: 35, h: 20, header: true, cells: [['Item', 'Cost'], ['Rent', '900']] },
      { id: 'ch', type: 'chart', title: 'Sales', chartType: 'column', data: { categories: ['Jan'], series: [{ name: 'EU', values: [3] }] }, x: 60, y: 62, w: 35, h: 30 },
      { id: 'v', type: 'video', name: 'Demo.mp4', x: 80, y: 45, w: 15, h: 12 },
    ] },
  ] };
  const buf = await pdfFromDeck(deck, 'Review', { author: 'Olivia Owner', pictureData: async (id) => (id === 'p' ? { data: PNG, mime: 'image/png' } : null) });
  const pdf = await PDFDocument.load(buf);
  assert.equal(pdf.getTitle(), 'Review');
  assert.equal(pdf.getAuthor(), 'Olivia Owner');
  assert.equal(pdf.getPageCount(), 2, 'the skipped slide is left out');
  // A bookmark a slide, by its title (or its first words), numbered as in the deck.
  const marks = [];
  for (let r = pdf.catalog.lookup(PDFName.of('Outlines')).get(PDFName.of('First')); r;) { const n = pdf.context.lookup(r); marks.push(n.lookup(PDFName.of('Title')).decodeText()); r = n.get(PDFName.of('Next')); }
  assert.deepEqual(marks, ['1. Quarterly review', '3. • Hire two people • Open the shop 日本']);
  assert.deepEqual(pdf.getPages().map((p) => [p.getWidth(), p.getHeight()]), [[960, 540], [960, 540]]);
  assert.equal((await PDFDocument.load(await pdfFromDeck({ slides: [] }))).getPageCount(), 1, 'an empty deck: one blank page');
  const { execFileSync } = await import('node:child_process');
  let text;
  try { text = execFileSync('pdftotext', ['-layout', '-', '-'], { input: buf }).toString(); } catch { return; }
  assert.match(text, /Quarterly review/);
  assert.doesNotMatch(text, /Hidden slide/);
  assert.match(text, /• Hire two people\s*\n[\s\S]*• Open the shop \?\?/, 'line breaks kept; characters the fonts lack are ?');
  for (const w of ['Go', 'Item', 'Rent', '900', 'Sales', 'EU', 'Jan', '[Team photo]', 'Video: Demo.mp4']) assert.ok(text.includes(w), w);
  assert.match(text, /\b3\s*$/, 'slide 3 has its number (the first one has none)');
});

test('a presentation as a PDF with speaker notes: an A4 page a slide, the slide above its notes; long notes go on', async () => {
  const { notesPdfFromDeck } = await import('../src/office/slidepdf.js');
  const deck = { theme: 'light', slides: [
    { id: 'a', notes: 'Welcome everyone.\nThank the sponsors.', items: [{ id: 't', type: 'text', role: 'title', x: 10, y: 30, w: 80, h: 20, text: 'Launch plan' }] },
    { id: 'b', skip: true, notes: 'Hidden notes', items: [] },
    { id: 'c', items: [{ id: 't', type: 'text', role: 'title', x: 10, y: 30, w: 80, h: 20, text: 'Budget' }] },
    { id: 'd', notes: 'Long. '.repeat(1500), items: [{ id: 't', type: 'text', role: 'title', x: 10, y: 30, w: 80, h: 20, text: 'Details' }] },
  ] };
  const buf = await notesPdfFromDeck(deck, 'Launch', { author: 'Olivia Owner' });
  const pdf = await PDFDocument.load(buf);
  assert.equal(pdf.getTitle(), 'Launch (with notes)');
  assert.ok(pdf.getPageCount() >= 4, 'three slides, the last notes going on');
  assert.deepEqual(pdf.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())])[0], [595, 842]);
  const { execFileSync } = await import('node:child_process');
  let text;
  try { text = execFileSync('pdftotext', ['-layout', '-', '-'], { input: buf }).toString(); } catch { return; }
  const pages = text.split('\f');
  assert.match(pages[0], /Slide 1[\s\S]*Launch plan[\s\S]*Welcome everyone\.\s*\n\s*Thank the sponsors\./);
  assert.match(pages[1], /Slide 3[\s\S]*Budget[\s\S]*No speaker notes/);
  assert.match(pages[2], /Slide 4[\s\S]*Details[\s\S]*Long\./);
  assert.match(pages[3], /Long\./, 'long notes go on to another page');
  assert.doesNotMatch(text, /Hidden notes/);
});
