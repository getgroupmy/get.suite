// A presentation through LibreOffice: written as .pptx and as .odp, saved again by LibreOffice in the same format and read
// back, it is what our own file reads back as: text with its size, bold, colours and links, shapes (a star turned, an arrow,
// an ellipse linking to another slide), a picture with its alt text, speaker notes, a skipped slide with its own
// background, a table and a chart. (Our own files differ from the deck by design: the theme's colours come back as the
// colours themselves, slides get new ids, and a line's box is 8 tall around it in .pptx.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { soffice, hasSoffice } from './soffice.js';
import { odpFromDeck, deckFromOdp } from '../src/office/odp.js';
import { powerPointFromDeck, deckFromPowerPoint } from '../src/office/powerpoint.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const deck = { theme: 'dark', slides: [
  { id: 'a', notes: 'Say hello\nThen pause', items: [
    { id: 't1', type: 'text', x: 10, y: 10, w: 80, h: 20, text: 'Quarterly review\nQ3 2026', size: 50, bold: true, align: 'center', color: 'accent' },
    { id: 't2', type: 'text', x: 10, y: 40, w: 40, h: 10, text: 'See the site', size: 20, italic: true, link: { url: 'https://acme.example/' }, fill: '#333333', outline: '#ff0000', outlineW: 2 },
    { id: 's1', type: 'shape', shape: 'star', x: 60, y: 40, w: 20, h: 30, fill: '#ffd666', text: 'Win', rot: 30 },
    { id: 's2', type: 'shape', shape: 'arrow', dir: 'h', x: 10, y: 80, w: 30, h: 4, fill: '#ffffff' },
    { id: 's3', type: 'shape', shape: 'ellipse', x: 70, y: 75, w: 10, h: 15, fill: 'accent', link: { slide: 'b' } },
    { id: 'i1', type: 'image', fileId: 'p1', x: 50, y: 75, w: 10, h: 15, alt: 'A dot' },
  ] },
  { id: 'b', skip: true, bg: '#112233', items: [
    { id: 'tb', type: 'table', x: 5, y: 5, w: 60, h: 30, header: true, cells: [['Item', 'Qty'], ['Pens', '4']] },
    { id: 'c1', type: 'chart', x: 5, y: 50, w: 60, h: 45, title: 'Sales', chartType: 'column', data: { categories: ['Jan', 'Feb'], series: [{ name: 'EU', values: [3, 5] }] } },
  ] },
] };
const pictureData = async () => ({ data: PNG, mime: 'image/png' });
const savePicture = async () => 'pic';
/** A deck to compare: ids and picture names left out (made new on reading), a link to a slide as that slide's number. */
const comparable = (d) => {
  const at = new Map(d.slides.map((s, i) => [s.id, i + 1]));
  return JSON.parse(JSON.stringify(d, (k, v) => {
    if (k === 'id' || k === 'fileId' || k === 'name') return undefined;
    if (k === 'slide' && at.has(v)) return `slide ${at.get(v)}`;
    return typeof v === 'number' ? Math.round(v) : v;
  }));
};

for (const [ext, write, read] of [['pptx', powerPointFromDeck, deckFromPowerPoint], ['odp', odpFromDeck, deckFromOdp]]) {
  test(`through LibreOffice (.${ext}): saved again by it, the presentation reads back as ours does`, { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckrt-'));
    const ours = await write(deck, { pictureData });
    fs.writeFileSync(path.join(dir, `in.${ext}`), ours);
    soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', ext, '--outdir', path.join(dir, 'out'), path.join(dir, `in.${ext}`)]);
    const want = comparable(await read(ours, { savePicture })), got = comparable(await read(fs.readFileSync(path.join(dir, 'out', `in.${ext}`)), { savePicture }));
    assert.deepEqual(got, want);
    assert.equal(want.slides[0].items.find((i) => i.shape === 'ellipse').link.slide, 'slide 2', 'the link still goes to the second slide');
    assert.deepEqual([want.slides[1].skip, want.slides[0].notes, want.slides[1].items[0].cells], [true, 'Say hello\nThen pause', [['Item', 'Qty'], ['Pens', '4']]]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
