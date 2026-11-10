import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
const { parsePages, combine, extract, pageCount, typeOf } = await import('../src/pdftools.js');

/** A PDF of n pages, each with a different width so pages can be told apart. */
export async function makePdf(n, base = 100) {
  const d = await PDFDocument.create();
  for (let i = 0; i < n; i++) d.addPage([base + i, 200]);
  return Buffer.from(await d.save());
}
// A 2x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwQZGBgAOe4F+3cjr+0AAAAASUVORK5CYII=', 'base64');

test('page lists: ranges, open ends, order kept, and clear errors', () => {
  assert.deepEqual(parsePages('1-3, 5', 6).pages, [0, 1, 2, 4]);
  assert.deepEqual(parsePages('5,1', 6).pages, [4, 0]);
  assert.deepEqual(parsePages('4-', 6).pages, [3, 4, 5]);
  assert.deepEqual(parsePages('-2', 6).pages, [0, 1]);
  assert.match(parsePages('', 6).error, /which pages/);
  assert.match(parsePages('7', 6).error, /has 6 pages/);
  assert.match(parsePages('3-1', 6).error, /isn’t in it/);
  assert.match(parsePages('a', 6).error, /isn’t a page/);
});

test('combine PDFs and pictures in order; extract and turn pages', async () => {
  const a = await makePdf(2, 100), b = await makePdf(3, 300);
  const out = await PDFDocument.load(await combine([{ bytes: a, type: 'pdf', name: 'a.pdf' }, { bytes: PNG, type: 'png', name: 'p.png' }, { bytes: b, type: 'pdf', name: 'b.pdf' }]));
  assert.deepEqual(out.getPages().map((p) => Math.round(p.getWidth())), [100, 101, 842, 300, 301, 302], 'a, then the wide picture on a landscape A4 page, then b');
  await assert.rejects(combine([{ bytes: Buffer.from('nope'), type: 'pdf', name: 'bad.pdf' }]), /“bad.pdf” couldn’t be read/);
  const ex = await PDFDocument.load(await extract(b, [2, 0], 90));
  assert.deepEqual(ex.getPages().map((p) => [Math.round(p.getWidth()), p.getRotation().angle]), [[302, 90], [300, 90]]);
  assert.equal(await pageCount(b), 3);
  assert.equal(typeOf({ name: 'Scan.PDF' }), 'pdf');
  assert.equal(typeOf({ name: 'x', mime: 'image/jpeg' }), 'jpg');
  assert.equal(typeOf({ name: 'notes.txt' }), null);
});

test('stamping pictures on pages: upright pages and turned ones', async () => {
  const { stamp } = await import('../src/pdftools.js');
  const d = await PDFDocument.create();
  d.addPage([200, 400]);
  const turned = d.addPage([200, 400]);
  const { degrees } = await import('pdf-lib');
  turned.setRotation(degrees(90));
  const bytes = Buffer.from(await d.save());
  const out = await PDFDocument.load(await stamp(bytes, [
    { page: 0, x: 0.5, y: 0.9, w: 0.4, h: 0.05, png: PNG },
    { page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2, png: PNG },
  ]));
  assert.equal(out.getPageCount(), 2);
  // Each page now draws a picture (an XObject in its resources).
  for (const p of out.getPages()) assert.ok(String(p.node.Resources().lookup((await import('pdf-lib')).PDFName.of('XObject'))).includes('/Image') || p.node.Resources().get((await import('pdf-lib')).PDFName.of('XObject')));
  await assert.rejects(stamp(bytes, [{ page: 5, x: 0, y: 0, w: 0.1, h: 0.1, png: PNG }]), /no page 6/);
});
