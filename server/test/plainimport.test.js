import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docFromTextFile, docFromWebPage, sheetFromDelimited } from '../src/office/plainimport.js';
import { htmlFromDoc, textFromDoc } from '../src/office/epub.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const T = (text, ...m) => ({ type: 'text', text, ...(m.length && { marks: m.map((x) => (typeof x === 'string' ? { type: x } : x)) }) });
const P = (...content) => ({ type: 'paragraph', content });
const shape = (d) => d.content.map((n) => [n.type, ...(n.content || []).map((c) => (c.type === 'text' ? `${c.text}${c.marks ? `{${c.marks.map((m) => m.type).join()}}` : ''}` : `${c.type}${c.attrs?.latex ? `:${c.attrs.latex}` : c.attrs?.note ? `:${c.attrs.note}` : ''}`))]);

test('a text file: a paragraph a line (a byte-order mark and Windows line ends aside), blank lines kept', () => {
  const d = docFromTextFile(Buffer.from('﻿Hello\r\n\r\n\tIndented\r\n# not a heading\n\n'));
  assert.deepEqual(shape(d), [['paragraph', 'Hello'], ['paragraph'], ['paragraph', '    Indented'], ['paragraph', '# not a heading']]);
  assert.deepEqual(docFromTextFile(Buffer.from('')).content, [{ type: 'paragraph' }]);
  // What the plain text download writes comes back as its lines.
  assert.deepEqual(shape(docFromTextFile(Buffer.from(textFromDoc({ type: 'doc', content: [P(T('One')), P(T('Two'))] })))), [['paragraph', 'One'], ['paragraph'], ['paragraph', 'Two']]);
});

test('a web page: our download comes back with its formatting, picture, equation and footnote; scripts and pictures elsewhere don\'t', async () => {
  const doc = { type: 'doc', content: [{ type: 'tableOfContents' }, { type: 'heading', attrs: { level: 1 }, content: [T('Plan')] },
    P(T('Bold', 'bold'), T(' and '), T('link', { type: 'link', attrs: { href: 'https://x.example' } }), { type: 'footnote', attrs: { note: 'A note & more' } }, T(' '), { type: 'math', attrs: { latex: '\\frac{1}{2}' } }),
    { type: 'image', attrs: { fileId: 'p1', alt: 'Dot' } },
    { type: 'bulletList', content: [{ type: 'listItem', content: [P(T('One'))] }] }] };
  const html = await htmlFromDoc(doc, 'P', { pictureData: async () => ({ data: PNG, mime: 'image/png' }) });
  const saved = [];
  const back = await docFromWebPage(html, { savePicture: async (n, d, m) => { saved.push([n, d.equals(PNG), m]); return 'NEWID'; } });
  assert.deepEqual(shape(back), [['heading', 'Plan'], ['paragraph', 'Bold{bold}', ' and ', 'link{link}', 'footnote:A note & more', ' ', 'math:\\frac{1}{2}'], ['image'], ['bulletList', 'listItem']]);
  assert.equal(back.content[2].attrs.fileId, 'NEWID');
  assert.equal(back.content[2].attrs.alt, 'Dot');
  assert.deepEqual(saved, [['Picture 1.png', true, 'image/png']]);
  // Someone else's page: scripts and styles go, a picture on another site is its description, not fetched.
  const other = await docFromWebPage(Buffer.from('<html><head><style>p{}</style></head><body><script>alert(1)</script><h2>Hi</h2><p onclick="x()">Text <img src="https://tracker.example/p.gif" alt="Logo"><img src="https://tracker.example/q.gif"></p></body></html>'), { savePicture: async () => assert.fail('nothing to save') });
  assert.deepEqual(shape(other), [['heading', 'Hi'], ['paragraph', 'Text ', '[Logo]{italic}']]);
  assert.equal(JSON.stringify(other).includes('alert'), false);
});

test('CSV and TSV files as a spreadsheet of one sheet', () => {
  assert.deepEqual(sheetFromDelimited(Buffer.from('﻿Name,Note\r\nAna,"says ""hi"", twice"\r\n,\r\nBo,\n'), 'People'),
    { sheets: [{ name: 'People', cells: { A1: 'Name', B1: 'Note', A2: 'Ana', B2: 'says "hi", twice', A4: 'Bo' } }] });
  assert.deepEqual(sheetFromDelimited(Buffer.from('a\tb\n1,5\t"2"\n'), 'T', '\t'), { sheets: [{ name: 'T', cells: { A1: 'a', B1: 'b', A2: '1,5', B2: '"2"' } }] });
  assert.equal(sheetFromDelimited(Buffer.from(''), '').sheets[0].name, 'Sheet1');
});
