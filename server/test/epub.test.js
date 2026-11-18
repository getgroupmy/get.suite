import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { parseDocument } from 'htmlparser2';
const { epubFromDoc, htmlFromDoc, textFromDoc, EPUB_MIME } = await import('../src/office/epub.js');
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

test('equations go into the e-book as MathML (the chapter marked as having it)', async () => {
  const d = { type: 'doc', content: [H(1, 'One'), P(T('Plain.')), H(1, 'Two'), P(T('Area '), { type: 'math', attrs: { latex: '\\pi r^2' } }, T('.'))] };
  const zip = await JSZip.loadAsync(await epubFromDoc(d, 'Maths'));
  const ch2 = await zip.file('OEBPS/chapter2.xhtml').async('string');
  assert.match(ch2, /<p>Area <math xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML" alttext="\\pi r\^2"><semantics><mrow><mi>π<\/mi><msup><mrow><mi>r<\/mi><\/mrow><mrow><mn>2<\/mn><\/mrow><\/msup><\/mrow><annotation encoding="application\/x-tex">\\pi r\^2<\/annotation><\/semantics><\/math>\.<\/p>/);
  parseDocument(ch2, { xmlMode: true }); // (well-formed)
  const opf = await zip.file('OEBPS/content.opf').async('string');
  assert.match(opf, /<item id="c2" href="chapter2.xhtml" media-type="application\/xhtml\+xml" properties="mathml"\/>/);
  assert.match(opf, /<item id="c1" href="chapter1.xhtml" media-type="application\/xhtml\+xml"\/>/, 'only chapters with equations say so');
});

const rich = { type: 'doc', content: [
  { type: 'tableOfContents' },
  H(1, 'Expenses and travel'),
  P(T('Claim within '), T('30 days', 'bold'), T(' at '), T('the portal', { type: 'link', attrs: { href: 'https://acme.example/claims' } }), { type: 'footnote', attrs: { note: 'Or ask Kim.' } }, T('.')),
  { type: 'bulletList', content: [{ type: 'listItem', content: [P(T('Trains'))] }, { type: 'listItem', content: [P(T('Hotels'))] }] },
  { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [P(T('Third'))] }] },
  { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [P(T('Done'))] }, { type: 'taskItem', attrs: { checked: false }, content: [P(T('Open'))] }] },
  H(2, 'Expenses and travel'),
  P(T('Area: '), { type: 'math', attrs: { latex: '\\pi r^2' } }, T(' <b>not bold</b>')),
  { type: 'image', attrs: { fileId: 'p1', alt: 'A dot' } },
  { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [P(T('Item'))] }, { type: 'tableHeader', content: [P(T('Cost'))] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [P(T('Taxi'))] }, { type: 'tableCell', content: [P(T('12'))] }] }] },
  { type: 'blockquote', content: [P(T('Keep receipts.'))] },
] };
test('the document as one web page (.html): self-contained pictures, MathML, contents with working links, footnotes', async () => {
  const html = (await htmlFromDoc(rich, 'Handbook', { pictureData: async (id) => (id === 'p1' ? { data: PNG, mime: 'image/png' } : null) })).toString('utf8');
  assert.match(html, /^<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"\/>.*<title>Handbook<\/title>/s);
  assert.match(html, /<nav class="toc"><p><strong>Contents<\/strong><\/p><ul><li class="toc1"><a href="#expenses-and-travel">Expenses and travel<\/a><\/li><li class="toc2"><a href="#expenses-and-travel-2">Expenses and travel<\/a><\/li><\/ul><\/nav>/);
  assert.match(html, /<h1 id="expenses-and-travel">Expenses and travel<\/h1>/);
  assert.match(html, /<h2 id="expenses-and-travel-2">/);
  assert.match(html, /<strong>30 days<\/strong> at <a href="https:\/\/acme.example\/claims">the portal<\/a><a id="r1" href="#n1"><sup>1<\/sup><\/a>\./);
  assert.match(html, /<p id="n1"><a href="#r1">1\.<\/a> Or ask Kim\.<\/p>/);
  assert.equal(/epub:type/.test(html), false);
  assert.match(html, /<math xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML" alttext="\\pi r\^2">/);
  assert.match(html, /&lt;b&gt;not bold&lt;\/b&gt;/, 'text is escaped');
  assert.match(html, /<img src="data:image\/png;base64,iVBORw0KGgo[^"]*" alt="A dot"\/>/);
  assert.match(html, /<th>.*Item.*<\/th>/);
  assert.doesNotMatch(html, /<h1>Handbook<\/h1>/, 'it starts with its own heading (after the contents), so no title heading is added');
});

test('the document as plain text (.txt)', () => {
  assert.equal(textFromDoc(rich), [
    'Expenses and travel',
    'Claim within 30 days at the portal (https://acme.example/claims)[1].',
    '- Trains\n- Hotels',
    '3. Third',
    '[x] Done\n[ ] Open',
    'Expenses and travel',
    'Area: \\pi r^2 <b>not bold</b>',
    '[A dot]',
    'Item\tCost\nTaxi\t12',
    '> Keep receipts.',
  ].join('\n\n') + '\n\n[1] Or ask Kim.\n');
  assert.equal(textFromDoc({ type: 'doc', content: [] }), '\n');
});
