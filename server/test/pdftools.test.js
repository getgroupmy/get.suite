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
