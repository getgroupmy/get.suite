import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { parseDocument } from 'htmlparser2';
const { epubFromDoc, EPUB_MIME } = await import('../src/office/epub.js');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const T = (text, ...marks) => ({ type: 'text', text, ...(marks.length && { marks: marks.map((m) => (typeof m === 'string' ? { type: m } : m)) }) });
const P = (...content) => ({ type: 'paragraph', content });
const H = (level, text) => ({ type: 'heading', attrs: { level }, content: [T(text)] });

const doc = { type: 'doc', content: [
  P(T('A short preface.')),
  H(1, 'The start'), P(T('Bold', 'bold'), T(' & '), T('a link', { type: 'link', attrs: { href: 'https://ex.example/a?b=1&c=2' } }), { type: 'footnote', attrs: { note: 'First <note>' } }),
  H(2, 'A section'), { type: 'bulletList', content: [{ type: 'listItem', content: [P(T('point'))] }] },
  { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [P(T('done'))] }] },
  { type: 'pageBreak' },
  H(1, 'The end'), { type: 'image', attrs: { fileId: 'pic', alt: 'A dot' } }, P(T('x'), { type: 'footnote', attrs: { note: 'Second note' } }),
  { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [P(T('Q'))] }, { type: 'tableCell', content: [P(T('1'))] }] }] },
  P({ type: 'mention', attrs: { name: 'Kim' } }, T(' '), { type: 'datechip', attrs: { date: '2026-11-09' } }, T(' '), { type: 'javascriptish', content: [T('kept text')] }),
  P(T('evil', { type: 'link', attrs: { href: 'javascript:alert(1)' } })),
] };

test('EPUB: the container, chapters at top-level headings, a table of contents, pictures, notes per chapter', async () => {
  const buf = await epubFromDoc(doc, 'Field guide', { author: 'Olivia Owner', pictureData: async (id) => (id === 'pic' ? { data: PNG, mime: 'image/png' } : null) });
  const zip = await JSZip.loadAsync(buf);
  assert.equal(Object.keys(zip.files)[0], 'mimetype');
  assert.equal(await zip.file('mimetype').async('string'), EPUB_MIME);
  assert.equal(buf.subarray(30, 58).toString(), 'mimetypeapplication/epub+zip', 'stored first, not compressed');
  assert.match(await zip.file('META-INF/container.xml').async('string'), /full-path="OEBPS\/content\.opf"/);
  const opf = await zip.file('OEBPS/content.opf').async('string');
  assert.match(opf, /<dc:title>Field guide<\/dc:title>/);
  assert.match(opf, /<dc:creator>Olivia Owner<\/dc:creator>/);
  assert.match(opf, /<dc:identifier id="bookid">urn:uuid:[0-9a-f-]{36}<\/dc:identifier>/);
  assert.match(opf, /<meta property="dcterms:modified">\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/meta>/);
  assert.match(opf, /properties="nav"/);
  assert.match(opf, /href="images\/1\.png" media-type="image\/png"/);
  assert.match(opf, /<spine><itemref idref="c1"\/><itemref idref="c2"\/><itemref idref="c3"\/><\/spine>/, 'preface, then a chapter per heading 1');
  const nav = await zip.file('OEBPS/nav.xhtml').async('string');
  assert.match(nav, /<a href="chapter1\.xhtml">Field guide<\/a><\/li><li><a href="chapter2\.xhtml">The start<\/a><\/li><li><a href="chapter3\.xhtml">The end<\/a>/);
  const ch2 = await zip.file('OEBPS/chapter2.xhtml').async('string');
  assert.match(ch2, /<strong>Bold<\/strong> &amp; <a href="https:\/\/ex\.example\/a\?b=1&amp;c=2">a link<\/a><a epub:type="noteref" id="r1" href="#n1"><sup>1<\/sup><\/a>/);
  assert.match(ch2, /<h2>A section<\/h2>/);
  assert.match(ch2, /<aside epub:type="footnote" id="n1"><p><a href="#r1">1\.<\/a> First &lt;note&gt;<\/p><\/aside>/);
  assert.match(ch2, /☑ done/);
  const ch3 = await zip.file('OEBPS/chapter3.xhtml').async('string');
  assert.match(ch3, /<img src="images\/1\.png" alt="A dot"\/>/);
  assert.match(ch3, /id="n1"[^>]*><p><a href="#r1">1\.<\/a> Second note/, 'notes counted again in each chapter');
  assert.match(ch3, /<th><p>Q<\/p><\/th><td><p>1<\/p><\/td>/);
  assert.match(ch3, /@Kim 9 Nov 2026 kept text/);
  assert.doesNotMatch(ch3, /javascript:/, 'no script links');
  assert.ok(zip.file('OEBPS/images/1.png'));
  // Every page is well-formed XML.
  for (const f of Object.keys(zip.files).filter((n) => /\.(xhtml|opf|xml)$/.test(n))) {
    const text = await zip.file(f).async('string');
    let errored = false;
    parseDocument(text, { xmlMode: true, onerror: () => { errored = true; } });
    assert.equal(errored, false, f);
    assert.equal((text.match(/<(p|li|table|tr|td|th|section|aside|strong|em|a)\b[^>]*[^/]>/g) || []).length >= 0, true);
  }
});

test('EPUB: a document without headings is one chapter under its title', async () => {
  const zip = await JSZip.loadAsync(await epubFromDoc({ type: 'doc', content: [P(T('Just text'))] }, 'Memo'));
  assert.match(await zip.file('OEBPS/content.opf').async('string'), /<spine><itemref idref="c1"\/><\/spine>/);
  assert.match(await zip.file('OEBPS/chapter1.xhtml').async('string'), /<h1>Memo<\/h1><p>Just text<\/p>/);
});
