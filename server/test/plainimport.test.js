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

test('a CSV opened as a spreadsheet: amounts and dates as written become numbers and dates in their formats', () => {
  const book = sheetFromDelimited(Buffer.from('Item,Price,Share,Due,Code\nDesk,"$1,250.00",40%,05/12/2026,007\nLamp,"1,234",12.5%,20 Dec 2026,A-1\n'), 'Orders');
  const { cells, formats } = book.sheets[0];
  assert.deepEqual([cells.B2, cells.C2, cells.D2, cells.B3, cells.C3, cells.D3, cells.E3], ['1250', '0.4', '2026-12-05', '1234', '0.125', '2026-12-20', 'A-1']);
  assert.deepEqual(formats.B2, { num: 'currency', cur: 'USD', dp: 2 });
  assert.deepEqual(formats.C3, { num: 'percent', dp: 1 });
  assert.deepEqual(formats.D2, { num: 'date', ds: 'short' });
  assert.deepEqual(formats.D3, { num: 'date', ds: 'medium' });
  assert.equal(formats.A2, undefined);
  assert.equal(cells.E2, '007'); // left as written
});

test('a semicolon CSV (as Excel saves in much of Europe): its columns, and decimal commas as numbers', () => {
  const s = sheetFromDelimited(Buffer.from('﻿Item;Price;Total\r\n"Paper, A4";1,5;1.234,50 €\r\nInk;2,25;12,5 %\r\nDue;05.12.2026;15\r\n'), 'Prices').sheets[0];
  assert.deepEqual(s.cells, { A1: 'Item', B1: 'Price', C1: 'Total', A2: 'Paper, A4', B2: '1.5', C2: '1234.5', A3: 'Ink', B3: '2.25', C3: '0.125', A4: 'Due', B4: '2026-12-05', C4: '15' });
  assert.deepEqual(s.formats, { B2: { num: 'number', dp: 1 }, C2: { num: 'currency', cur: 'EUR', dp: 2 }, B3: { num: 'number', dp: 2 }, C3: { num: 'percent', dp: 1 }, B4: { num: 'date', ds: 'short' } });
  // a comma file: commas are thousands, as before
  assert.deepEqual(sheetFromDelimited(Buffer.from('Item,Price\nPaper,"1,234.50"\n'), 'P').sheets[0].cells, { A1: 'Item', B1: 'Price', A2: 'Paper', B2: '1234.5' });
});
