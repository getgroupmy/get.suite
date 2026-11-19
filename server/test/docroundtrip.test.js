// Documents keep what they hold through Word and OpenDocument files, ours and as LibreOffice saves them again:
// pictures' size, place and alt text, links, horizontal lines, inline code, header rows; headings in the text's colour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { wordFromDoc, docFromWord, widthOfPicture, picturesOnTheirOwn } from '../src/office/word.js';
import { odtFromDoc, docFromOdt, textWidthCm } from '../src/office/odt.js';

// A real PNG of a given size (grey).
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const png = (w, h) => { const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2; const raw = Buffer.alloc((w * 3 + 1) * h, 0x80); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); };
const SMALL = png(400, 200), BIG = png(1600, 800);
const pictureData = async (id) => ({ data: id === 'big' ? BIG : SMALL, mime: 'image/png' });
const savePicture = async () => 'saved';

const T = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });
const P = (...c) => ({ type: 'paragraph', content: c });
const doc = { type: 'doc', content: [
  { type: 'heading', attrs: { level: 2 }, content: [T('Section')] },
  P(T('Go to '), T('our site', [{ type: 'link', attrs: { href: 'https://acme.example' } }]), T(' now.')),
  P(T('Run '), T('npm test', [{ type: 'code' }]), T(' first.')),
  { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [P(T('Item'))] }, { type: 'tableHeader', content: [P(T('Qty'))] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [P(T('Pens'))] }, { type: 'tableCell', content: [P(T('4'))] }] }] },
  { type: 'image', attrs: { fileId: 'small', alt: 'Half, centred', width: '50%', align: 'center' } },
  { type: 'image', attrs: { fileId: 'small', alt: 'Its own size' } },
  { type: 'image', attrs: { fileId: 'big', alt: 'Too big: page wide' } },
  { type: 'image', attrs: { fileId: 'big', alt: 'A quarter, right', width: '25%', align: 'right' } },
  { type: 'horizontalRule' },
  P(T('End')),
] };

// What matters of a document, comparable across formats.
const look = (d) => (d.doc || d).content.map((n) => {
  const text = (x) => (x.content || []).map((c) => (c.type === 'text' ? c.text : c.content ? text(c) : '')).join('');
  if (n.type === 'image') return `image ${n.attrs.alt} ${n.attrs.width || 'own'} ${n.attrs.align || 'left'}`;
  if (n.type === 'table') return `table ${n.content.map((r) => r.content.map((c) => `${c.type === 'tableHeader' ? '*' : ''}${text(c)}${JSON.stringify(c.content[0].content?.[0]?.marks || [])}`).join('|')).join(' / ')}`;
  const marks = (n.content || []).filter((c) => c.marks).map((c) => `${c.text}:${c.marks.map((m) => (m.type === 'link' ? `link ${m.attrs.href.replace(/\/$/, '')}` : m.type)).join('+')}`);
  return `${n.type}${n.attrs?.level ? n.attrs.level : ''} ${text(n)}${marks.length ? ` [${marks.join(', ')}]` : ''}`;
});
const want = [
  'heading2 Section',
  'paragraph Go to our site now. [our site:link https://acme.example]',
  'paragraph Run npm test first. [npm test:code]',
  'table *Item[]|*Qty[] / Pens[]|4[]',
  'image Half, centred 50% center',
  'image Its own size own left',
  'image Too big: page wide own left',
  'image A quarter, right 25% right',
  'horizontalRule ',
  'paragraph End',
];

test('.docx: pictures come back at their size and place, on their own (no empty paragraph before each), headings uncoloured', async () => {
  for (const page of [null, { size: 'a4' }, { size: 'letter', margin: 'narrow' }]) {
    const buf = await wordFromDoc(doc, 'T', { pictureData, page });
    assert.deepEqual(look(await docFromWord(buf, { savePicture })), want, JSON.stringify(page));
    const zip = await JSZip.loadAsync(buf);
    const styles = await zip.file('word/styles.xml').async('string');
    for (const id of ['Heading1', 'Heading2', 'Heading3', 'Heading4']) assert.doesNotMatch(/<w:style [^>]*w:styleId="${id}"[\s\S]*?<\/w:style>/.exec(styles)?.[0] || new RegExp(`<w:style [^>]*w:styleId="${id}"[\\s\\S]*?</w:style>`).exec(styles)[0], /<w:color |<w:i\/>/, `${id} in the text's colour, upright`);
    const body = await zip.file('word/document.xml').async('string');
    assert.doesNotMatch(body, /<\/w:tbl><w:p><w:r><w:t xml:space="preserve"><\/w:t><\/w:r><\/w:p>/, 'no empty paragraph after a table that a picture follows');
  }
});

test('.docx: two tables in a row stay two (an empty paragraph between), and one at the end is followed by one', async () => {
  const tb = (t) => ({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [P(T(t))] }] }] });
  const body = await (await JSZip.loadAsync(await wordFromDoc({ type: 'doc', content: [tb('A'), tb('B')] }, 'T'))).file('word/document.xml').async('string');
  assert.equal((body.match(/<\/w:tbl><w:p>/g) || []).length, 2);
  const back = await docFromWord(await wordFromDoc({ type: 'doc', content: [tb('A'), tb('B')] }, 'T'), {});
  assert.deepEqual(back.doc.content.filter((n) => n.type === 'table').length, 2);
});

test('a picture\'s width: none at its own size (or the page\'s, when bigger), else its share, the editor\'s sizes kept on other paper', () => {
  assert.equal(widthOfPicture({ px: 400, pagePx: 624 }, SMALL), null);
  assert.equal(widthOfPicture({ px: 624, pagePx: 624 }, BIG), null);
  assert.equal(widthOfPicture({ px: 312, pagePx: 624 }, BIG), '50%');
  assert.equal(widthOfPicture({ px: 312, pagePx: 601.7 }, BIG), '50%', 'A4: 51.9% is the editor\'s 50%');
  assert.equal(widthOfPicture({ px: 250, pagePx: 624 }, BIG), '40%');
  assert.equal(widthOfPicture({ px: 0, pagePx: 624 }, BIG), null);
  assert.equal(picturesOnTheirOwn('<p style="text-align: center"><img src="pic:a" alt=""></p><p>Text <img src="pic:b"></p>'), '<img align="center" src="pic:a" alt=""><p>Text <img src="pic:b"></p>');
});

test('.odt: pictures go out at their share of the page and aligned, and come back so; header cells and code as in .docx', async () => {
  assert.equal(textWidthCm(null), 17);
  assert.equal(Math.round(textWidthCm({ size: 'letter', margin: 'narrow' }) * 100) / 100, 19.05);
  for (const page of [null, { size: 'letter', margin: 'narrow' }]) {
    const buf = await odtFromDoc(doc, 'T', { pictureData, page });
    const xml = await (await JSZip.loadAsync(buf)).file('content.xml').async('string');
    const tw = textWidthCm(page);
    assert.match(xml, new RegExp(`<text:p text:style-name="Standard_center"><draw:frame [^>]*svg:width="${(tw / 2).toFixed(2)}cm"`), 'half the page, centred');
    assert.match(xml, /<text:p text:style-name="Standard_end"><draw:frame /, 'right');
    assert.deepEqual(look(await docFromOdt(buf, { savePicture })), want, JSON.stringify(page));
  }
});

test('.odt in: LibreOffice\'s ways: a line under an empty paragraph is a horizontal line; a link\'s blue is the link\'s', async () => {
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"';
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text');
  zip.file('styles.xml', `<office:document-styles ${NS}><office:styles><style:style style:name="Internet_20_link" style:family="text"><style:text-properties fo:color="#0563c1" style:text-underline-style="solid"/></style:style></office:styles></office:document-styles>`);
  zip.file('content.xml', `<office:document-content ${NS}><office:automatic-styles>
    <style:style style:name="P4" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:padding-bottom="0.0138in" fo:border-left="none" fo:border-right="none" fo:border-top="none" fo:border-bottom="0.74pt solid #bbbbbb"/></style:style>
    <style:style style:name="Box" style:family="paragraph"><style:paragraph-properties fo:border="0.74pt solid #000000"/></style:style>
    <style:style style:name="T1" style:family="text"><style:text-properties fo:color="#ff0000"/></style:style>
  </office:automatic-styles><office:body><office:text>
    <text:p>Go to <text:a xlink:href="https://acme.example" text:style-name="Internet_20_link"><text:span text:style-name="Internet_20_link">our site</text:span></text:a> or <text:a xlink:href="https://b.example"><text:span text:style-name="T1">red</text:span></text:a></text:p>
    <text:p text:style-name="P4"/><text:p text:style-name="Box"/><text:p>End</text:p>
  </office:text></office:body></office:document-content>`);
  const d = (await docFromOdt(await zip.generateAsync({ type: 'nodebuffer' }))).doc;
  assert.deepEqual(d.content.map((n) => n.type), ['paragraph', 'horizontalRule', 'paragraph', 'paragraph'], 'a boxed empty paragraph is not a line');
  const runs = d.content[0].content.filter((c) => c.marks).map((c) => [c.text, c.marks.map((m) => m.type === 'textStyle' ? m.attrs.color : m.type)]);
  assert.deepEqual(runs, [['our site', ['link']], ['red', ['link', '#ff0000']]], 'a colour chosen for a link stays');
});

test('.docx in: inline code in another fixed-width font (LibreOffice\'s Liberation Mono) is code; Courier New, a Docs font, is a font', async () => {
  const buf = await wordFromDoc({ type: 'doc', content: [P(T('a', [{ type: 'code' }]), T(' b', [{ type: 'textStyle', attrs: { fontFamily: '"Courier New", Courier, monospace' } }]))] }, 'T');
  const zip = await JSZip.loadAsync(buf);
  zip.file('word/document.xml', (await zip.file('word/document.xml').async('string')).replace(/w:ascii="Consolas" w:hAnsi="Consolas"/g, 'w:ascii="Liberation Mono" w:hAnsi="Liberation Mono"'));
  const [p] = (await docFromWord(await zip.generateAsync({ type: 'nodebuffer' }))).doc.content;
  assert.deepEqual(p.content.map((c) => [c.text, (c.marks || []).map((m) => m.type)]), [['a', ['code']], [' b', ['textStyle']]]);
});

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
test('through LibreOffice: our .docx and .odt, saved again by it in either format, come back the same', { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-docrt-'));
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as}`))); };
  try {
    fs.writeFileSync(path.join(dir, 'd.docx'), await wordFromDoc(doc, 'T', { pictureData }));
    fs.writeFileSync(path.join(dir, 'd.odt'), await odtFromDoc(doc, 'T', { pictureData }));
    assert.deepEqual(look(await docFromWord(lo('d.docx', 'docx', 'a'), { savePicture })), want, '.docx saved again as .docx');
    assert.deepEqual(look(await docFromOdt(lo('d.docx', 'odt', 'b'), { savePicture })), want, '.docx saved as .odt');
    assert.deepEqual(look(await docFromOdt(lo('d.odt', 'odt', 'c'), { savePicture })), want, '.odt saved again as .odt');
    assert.deepEqual(look(await docFromWord(lo('d.odt', 'docx', 'e'), { savePicture })), want, '.odt saved as .docx');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
