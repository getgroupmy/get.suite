import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, AlignmentType, Table, TableRow, TableCell } from 'docx';
import { docFromWord, wordFromDoc } from '../src/office/word.js';

const text = (n) => (n.content || []).map((c) => c.text ?? text(c)).join('');
const find = (doc, type) => doc.content.filter((n) => n.type === type);

test('Word: a real .docx opens as a document with headings, formatting, lists and links', async () => {
  const file = new Document({ numbering: { config: [{ reference: 'n', levels: [{ level: 0, format: 'decimal', text: '%1.' }] }] }, sections: [{ children: [
    new Paragraph({ text: 'Quarterly report', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun('Sales were '), new TextRun({ text: 'strong', bold: true }), new TextRun(' and '), new TextRun({ text: 'steady', italics: true }), new TextRun('.')] }),
    new Paragraph({ text: 'Centred note', alignment: AlignmentType.CENTER }),
    new Paragraph({ text: 'First point', bullet: { level: 0 } }),
    new Paragraph({ text: 'Second point', bullet: { level: 0 } }),
    new Paragraph({ children: [new TextRun('See '), new ExternalHyperlink({ link: 'https://example.com/q4', children: [new TextRun({ text: 'the figures', style: 'Hyperlink' })] })] }),
    new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('Region')] }), new TableCell({ children: [new Paragraph('Total')] })] }), new TableRow({ children: [new TableCell({ children: [new Paragraph('North')] }), new TableCell({ children: [new Paragraph('120')] })] })] }),
  ] }] });
  const { doc } = await docFromWord(await Packer.toBuffer(file));
  assert.equal(find(doc, 'heading')[0].attrs.level, 1);
  assert.equal(text(find(doc, 'heading')[0]), 'Quarterly report');
  const p = find(doc, 'paragraph')[0];
  assert.equal(text(p), 'Sales were strong and steady.');
  assert.deepEqual(p.content.filter((c) => c.marks).map((c) => [c.text, c.marks[0].type]), [['strong', 'bold'], ['steady', 'italic']]);
  assert.deepEqual(find(doc, 'bulletList')[0].content.map(text), ['First point', 'Second point']);
  const link = doc.content.flatMap((n) => n.content || []).find((c) => c.marks?.some((m) => m.type === 'link'));
  assert.equal(link.marks.find((m) => m.type === 'link').attrs.href, 'https://example.com/q4');
  const table = find(doc, 'table')[0];
  assert.deepEqual(table.content.map((row) => row.content.map(text)), [['Region', 'Total'], ['North', '120']], 'tables come through as tables');
});

test('Word: a document saved as .docx opens again the same', async () => {
  const doc = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] },
    { type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world', marks: [{ type: 'bold' }, { type: 'underline' }] }] },
    { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Two' }] }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] },
  ] };
  const buf = await wordFromDoc(doc, 'Plan');
  assert.equal(buf.subarray(0, 2).toString(), 'PK', 'a zip, as .docx files are');
  const { doc: back } = await docFromWord(buf);
  assert.equal(text(find(back, 'heading')[0]), 'Plan');
  const bold = find(back, 'paragraph')[0].content.find((c) => c.text === 'world');
  assert.deepEqual(bold.marks.map((m) => m.type).sort(), ['bold', 'underline']);
  assert.deepEqual(find(back, 'orderedList')[0].content.map(text), ['One', 'Two']);
  assert.ok(JSON.stringify(back).includes('https://example.com'));
});

import JSZip from 'jszip';
const WIDE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR42u3OMQEAAAgDoNm/tKbwgQJ0Uhk1NBQQEBAQEBAQEBAQEBAQ1gWjYCbJAAAAAElFTkSuQmCC', 'base64'); // 64 × 32

test('Word: tables, pictures and text colours go out to .docx and come back', async () => {
  const cell = (type, t) => ({ type, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'red', marks: [{ type: 'textStyle', attrs: { color: '#c5221f' } }] }, { type: 'text', text: ' marked', marks: [{ type: 'textStyle', attrs: { backgroundColor: '#fde293' } }] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader', 'Item'), cell('tableHeader', 'Cost')] }, { type: 'tableRow', content: [cell('tableCell', 'Paper'), cell('tableCell', '12')] }] },
    { type: 'image', attrs: { fileId: 'pic1', alt: 'Chart', width: '50%', align: 'center' } },
    { type: 'image', attrs: { fileId: 'gone', alt: '' } },
  ] };
  const asked = [];
  const buf = await wordFromDoc(doc, 'Costs', { pictureData: async (id) => { asked.push(id); return id === 'pic1' ? { data: WIDE_PNG, mime: 'image/png' } : null; } });
  assert.deepEqual(asked.sort(), ['gone', 'pic1']);
  const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
  assert.match(xml, /<w:color w:val="C5221F"\/>/);
  assert.match(xml, /w:fill="FDE293"/);
  assert.match(xml, /<w:tblHeader\/>/);
  assert.match(xml, /<wp:extent cx="\d+" cy="\d+"\/>/);
  const saved = [];
  const { doc: back } = await docFromWord(buf, { savePicture: async (name, data, mime) => { saved.push([name, mime, data.length]); return `new${saved.length}`; } });
  assert.deepEqual(find(back, 'table')[0].content.map((row) => row.content.map(text)), [['Item', 'Cost'], ['Paper', '12']]);
  assert.deepEqual(saved, [['Picture 1.png', 'image/png', WIDE_PNG.length]]);
  const img = JSON.stringify(back).match(/"type":"image","attrs":\{[^}]*\}/)[0];
  assert.match(img, /"fileId":"new1"/);
  assert.ok(JSON.stringify(back).includes('[picture]'), 'a picture that could not be read leaves a note');
});

import ExcelJS from 'exceljs';
import { sheetFromExcel, excelFromSheet, numFromExcel, formulaFromExcel, formulaToExcel } from '../src/office/excel.js';

test('Excel: a real .xlsx opens with values, formulas, formats and every sheet', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Q4 Sales');
  ws.getCell('A1').value = 'Item'; ws.getCell('A1').font = { bold: true }; ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF7E0' } };
  ws.getCell('B1').value = 'Price';
  ws.getCell('A2').value = 'Bolts'; ws.getCell('B2').value = 1234.5; ws.getCell('B2').numFmt = '"RM"#,##0.00';
  ws.getCell('A3').value = 'Nuts'; ws.getCell('B3').value = 20;
  ws.getCell('B4').value = { formula: 'SUM(B2:B3)', result: 1254.5 };
  ws.getCell('C2').value = 0.125; ws.getCell('C2').numFmt = '0.0%'; ws.getCell('C2').alignment = { horizontal: 'center' };
  ws.getColumn('A').width = 20;
  wb.addWorksheet('Notes').getCell('A1').value = 'Second sheet';
  const s = await sheetFromExcel(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.deepEqual(s.sheets.map((x) => x.name), ['Q4 Sales', 'Notes']);
  const q = s.sheets[0];
  assert.deepEqual([q.cells.A2, q.cells.B2, q.cells.B4, q.cells.C2], ['Bolts', '1234.5', '=SUM(B2:B3)', '0.125']);
  assert.deepEqual(q.formats.A1, { b: 1, fill: '#fef7e0' });
  assert.deepEqual(q.formats.B2, { num: 'currency', cur: 'MYR', dp: 2 });
  assert.deepEqual(q.formats.C2, { align: 'center', num: 'percent', dp: 1 });
  assert.equal(q.colWidths.A, 145);
  assert.equal(s.sheets[1].cells.A1, 'Second sheet');
});

test('Excel: a spreadsheet saved as .xlsx opens again the same', async () => {
  const data = { sheets: [{ name: 'Budget', frozen: { rows: 1, cols: 2 }, rules: [
    { id: 'a', range: 'B1:B9', when: 'gt', value: '100', fill: '#fce8e6', color: '#c5221f', bold: true },
    { id: 'b', range: 'A1:A9', when: 'contains', value: 'late', fill: '#fef7e0' },
    { id: 'c', range: 'C1:C9', when: 'between', value: '1', value2: '5', fill: '#e6f4ea' },
    { id: 'd', range: 'D1:D9', when: 'eq', value: 'Done', fill: '#e8f0fe' },
    { id: 'e', range: 'E1:E9', when: 'empty', fill: '#f1f3f4' },
    { id: 'f', range: 'F1:F9', when: 'notContains', value: 'say "ok"', fill: '#f3e8fd' },
    { id: 'g', range: 'G1:G9', when: 'starts', value: 'INV', fill: '#e6f4ea' },
  ], cells: { A1: 'Cost', B1: '100', B2: '=B1*2', C1: 'TRUE' }, colWidths: { A: 145 }, formats: { A1: { b: 1, color: '#c5221f' }, B1: { num: 'currency', cur: 'USD', dp: 2 }, B2: { num: 'percent', dp: 0 } } }] };
  const back = await sheetFromExcel(await excelFromSheet(data));
  const b = back.sheets[0];
  assert.deepEqual([b.name, b.cells.A1, b.cells.B1, b.cells.B2, b.cells.C1], ['Budget', 'Cost', '100', '=B1*2', 'TRUE']);
  assert.deepEqual(b.formats.A1, { b: 1, color: '#c5221f' });
  assert.deepEqual(b.formats.B1, { num: 'currency', cur: 'USD', dp: 2 });
  assert.deepEqual(b.formats.B2, { num: 'percent', dp: 0 });
  assert.equal(b.colWidths.A, 145);
  assert.deepEqual(b.frozen, { rows: 1, cols: 2 }, 'frozen rows and columns');
  assert.deepEqual(b.rules?.map(({ id, ...r }) => r), [
    { range: 'B1:B9', when: 'gt', value: '100', fill: '#fce8e6', color: '#c5221f', bold: true },
    { range: 'A1:A9', when: 'contains', value: 'late', fill: '#fef7e0' },
    { range: 'C1:C9', when: 'between', value: '1', value2: '5', fill: '#e6f4ea' },
    { range: 'D1:D9', when: 'eq', value: 'Done', fill: '#e8f0fe' },
    { range: 'E1:E9', when: 'empty', fill: '#f1f3f4' },
    { range: 'F1:F9', when: 'notContains', value: 'say "ok"', fill: '#f3e8fd' },
    { range: 'G1:G9', when: 'starts', value: 'INV', fill: '#e6f4ea' },
  ], 'conditional formatting');
  assert.deepEqual(numFromExcel('$#,##0'), { num: 'currency', cur: 'USD', dp: 0 });
});

import PptxGenJS from 'pptxgenjs';
import { deckFromPowerPoint, powerPointFromDeck } from '../src/office/powerpoint.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('PowerPoint: a real .pptx opens with its slides, boxes, text, shapes, pictures and backgrounds', async () => {
  const p = new PptxGenJS(); p.layout = 'LAYOUT_WIDE';
  const s1 = p.addSlide(); s1.background = { color: 'FEF7E0' };
  s1.addText('Series A', { x: 1, y: 2, w: 11.333, h: 1.5, fontSize: 44, bold: true, align: 'center', color: '1A73E8' });
  s1.addText('Acme Trading, 2027', { x: 2, y: 4, w: 9.333, h: 1, fontSize: 24, italic: true });
  const s2 = p.addSlide();
  s2.addShape(p.ShapeType.ellipse, { x: 0.5, y: 0.5, w: 2, h: 2, fill: { color: 'D93025' } });
  s2.addImage({ data: `data:image/png;base64,${PNG.toString('base64')}`, x: 6.6665, y: 3.75, w: 3.333, h: 1.875 });
  s2.addText(['Revenue up 12%', 'New office opened'].join('\n'), { x: 0.5, y: 3, w: 6, h: 3, fontSize: 20 });
  const saved = [];
  const deck = await deckFromPowerPoint(await p.write({ outputType: 'nodebuffer' }), { savePicture: async (name, data, mime) => { saved.push({ name, mime, size: data.length }); return 'pic1'; } });
  assert.equal(deck.slides.length, 2);
  const [title, sub] = deck.slides[0].items;
  assert.equal(deck.slides[1].items.find((i) => i.type === 'image').alt, undefined, 'a description that is only the picture\'s data is left out');
  const r = (v) => Math.round(v);
  assert.deepEqual([title.text, title.bold, title.align, title.color, r(title.x), r(title.y), r(title.w)], ['Series A', true, 'center', '#1a73e8', 8, 27, 85]);
  assert.equal(title.size, 46, '44 pt on a 13.33 in slide');
  assert.deepEqual([sub.text, sub.italic], ['Acme Trading, 2027', true]);
  assert.equal(deck.slides[0].bg, '#fef7e0');
  const items2 = deck.slides[1].items;
  assert.deepEqual(items2.find((i) => i.type === 'shape'), { ...items2.find((i) => i.type === 'shape'), shape: 'ellipse', fill: '#d93025' });
  const pic = items2.find((i) => i.type === 'image');
  assert.deepEqual([pic.fileId, r(pic.x), r(pic.y), r(pic.w), r(pic.h)], ['pic1', 50, 50, 25, 25]);
  assert.equal(saved[0].mime, 'image/png');
  assert.equal(items2.find((i) => i.type === 'text').text, 'Revenue up 12%\nNew office opened');
});

test('PowerPoint: a video on a slide goes in as a playable video (too big: its name instead)', async () => {
  const JSZip = (await import('jszip')).default;
  const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(2000, 7)]);
  const deck = { theme: 'light', slides: [{ id: 'a', items: [
    { id: 'v', type: 'video', fileId: 'vid1', name: 'demo.mp4', x: 10, y: 10, w: 60, h: 60 },
    { id: 'w', type: 'video', fileId: 'gone', name: 'missing.mp4', x: 70, y: 70, w: 20, h: 20 },
  ] }] };
  const buf = await powerPointFromDeck(deck, { pictureData: async (id) => (id === 'vid1' ? { data: fakeMp4, mime: 'video/mp4' } : null) });
  const zip = await JSZip.loadAsync(buf);
  const media = Object.keys(zip.files).filter((n) => /^ppt\/media\/.+\.mp4$/.test(n));
  assert.equal(media.length, 1, Object.keys(zip.files).join(' '));
  assert.equal((await zip.file(media[0]).async('nodebuffer')).length, fakeMp4.length);
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  assert.match(xml, /<a:videoFile /);
  assert.match(xml, /▶ missing\.mp4/, 'a video that can\'t be had: its name');
});

test('PowerPoint: a presentation saved as .pptx opens again the same', async () => {
  const deck = { theme: 'ocean', slides: [
    { id: 'a', notes: 'Welcome everyone.\nMention the Q3 numbers.', items: [{ id: 't', type: 'text', text: 'Hello', x: 10, y: 20, w: 50, h: 15, size: 44, bold: true, align: 'center' }, { id: 's', type: 'shape', shape: 'round', fill: 'accent', x: 60, y: 60, w: 20, h: 20 }] },
    { id: 'b', bg: '#ffffff', items: [{ id: 'p', type: 'image', fileId: 'f1', x: 25, y: 25, w: 50, h: 50, alt: 'Bar chart: sales doubled from 2025 to 2026', name: 'chart.png' },
      { id: 'q', type: 'image', fileId: 'f2', x: 80, y: 5, w: 10, h: 10, name: 'logo.png' }] },
  ] };
  const buf = await powerPointFromDeck(deck, { pictureData: async () => ({ data: PNG, mime: 'image/png' }) });
  const back = await deckFromPowerPoint(buf, { savePicture: async () => 'new-pic' });
  assert.equal(back.slides.length, 2);
  const t = back.slides[0].items.find((i) => i.type === 'text');
  assert.deepEqual([t.text, t.bold, t.align, Math.round(t.x), Math.round(t.y), t.size], ['Hello', true, 'center', 10, 20, 44]);
  assert.equal(t.color, '#ffffff', 'theme text colour written out');
  assert.equal(back.slides[0].bg, '#0b57d0', 'theme background written out');
  assert.deepEqual(back.slides[0].items.find((i) => i.type === 'shape').shape, 'round');
  assert.equal(back.slides[1].items[0].fileId, 'new-pic');
  assert.equal(back.slides[1].items[0].alt, 'Bar chart: sales doubled from 2025 to 2026', 'alt text both ways');
  assert.equal(back.slides[1].items[1].alt, undefined, 'none stays none');
  const xml = await (await (await import('jszip')).default.loadAsync(buf)).file('ppt/slides/slide2.xml').async('string');
  assert.ok(!xml.includes('descr="data:'), 'the picture itself is never written as its description');
  assert.equal(back.slides[0].notes, 'Welcome everyone.\nMention the Q3 numbers.', 'speaker notes');
  assert.equal(back.slides[1].notes, undefined);
});

test('Excel: dropdowns and tick boxes go to Excel and come back', async () => {
  const data = { sheets: [{ name: 'Tracker', cells: { A1: 'Status', B1: 'Done?', A2: 'Open', B2: 'TRUE', D1: 'Low', D2: 'High' }, validations: [
    { id: 'a', range: 'A2:A20', type: 'list', values: ['Open', 'In progress', 'Done'], strict: true },
    { id: 'b', range: 'B2:B20', type: 'checkbox' },
    { id: 'c', range: 'C2:C5', type: 'list', values: ['x', 'y'], strict: false },
  ] }] };
  const back = (await sheetFromExcel(await excelFromSheet(data))).sheets[0];
  assert.deepEqual(back.validations.map(({ id, ...v }) => v), [
    { range: 'A2:A20', type: 'list', values: ['Open', 'In progress', 'Done'], strict: true },
    { range: 'B2:B20', type: 'checkbox' },
    { range: 'C2:C5', type: 'list', values: ['x', 'y'], strict: false },
  ]);
});

test('Excel: a list taken from cells on the sheet, and split ranges', async () => {
  const { validationsFromExcel } = await import('../src/office/excel.js');
  const list = { type: 'list', formulae: ['$D$1:$D$3'], showErrorMessage: true };
  const got = validationsFromExcel({ A1: list, A2: list, A4: list, B1: { type: 'whole', formulae: ['1'] } }, { D1: 'Low', D2: 'High', D3: 'Low' });
  assert.deepEqual(got.map(({ id, ...v }) => v), [
    { range: 'A1:A2', type: 'list', source: 'D1:D3', strict: true },
    { range: 'A4:A4', type: 'list', source: 'D1:D3', strict: true },
  ]);
  // On another tab too, and a TRUE/FALSE range on this sheet is still a tick box.
  const other = validationsFromExcel({ B2: { type: 'list', formulae: ["'Q1 data'!$A$2:$A$9"] }, C2: { type: 'list', formulae: ['$E$1:$E$2'] } }, { E1: 'TRUE', E2: 'FALSE' });
  assert.deepEqual(other.map(({ id, ...v }) => v), [
    { range: 'B2:B2', type: 'list', source: "'Q1 data'!A2:A9", strict: false },
    { range: 'C2:C2', type: 'checkbox' },
  ]);
});

test('Excel: a dropdown taking its choices from a range is written as that range, and read back', async () => {
  const { sourceFormula } = await import('../src/office/excel.js');
  assert.equal(sourceFormula('Lists!A2:A9'), 'Lists!$A$2:$A$9');
  assert.equal(sourceFormula("'Q1 data'!b2:b5"), "'Q1 data'!$B$2:$B$5");
  assert.equal(sourceFormula('D2:D9'), '$D$2:$D$9');
  assert.equal(sourceFormula('nonsense'), null);
  const book = { sheets: [
    { name: 'Tasks', cells: { A1: 'Status', A2: 'Open' }, validations: [{ id: 'v1', range: 'A2:A20', type: 'list', source: 'Lists!A2:A4', strict: true, colors: { Open: '#ceead6' } }] },
    { name: 'Lists', cells: { A1: 'Choices', A2: 'Open', A3: 'Done', A4: 'Later' } },
  ] };
  const buf = await excelFromSheet(book);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const dv = wb.getWorksheet('Tasks').dataValidations.model;
  assert.deepEqual(dv['A2:A20']?.formulae || dv.A2?.formulae, ['Lists!$A$2:$A$4']);
  const back = await sheetFromExcel(buf);
  assert.deepEqual(back.sheets[0].validations.map(({ id, ...v }) => v), [{ range: 'A2:A20', type: 'list', source: 'Lists!A2:A4', strict: true }]);
});

test('Word: the page setup goes into the .docx (size, orientation, margins, header, footer, page numbers)', async () => {
  const JSZip = (await import('jszip')).default;
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] };
  const buf = await wordFromDoc(doc, 'Setup', { page: { size: 'a4', orientation: 'landscape', margin: 'narrow', header: 'Acme Trading', footer: 'Confidential', numbers: true } });
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/);
  assert.match(xml, /<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/);
  const files = Object.keys(zip.files);
  const header = await zip.file(files.find((f) => /word\/header\d*\.xml/.test(f))).async('string');
  const footer = await zip.file(files.find((f) => /word\/footer\d*\.xml/.test(f))).async('string');
  assert.match(header, /Acme Trading/);
  assert.match(footer, /Confidential/);
  assert.match(footer, /PAGE/);
  const plain = await wordFromDoc(doc, 'Plain');
  assert.ok(!Object.keys((await JSZip.loadAsync(plain)).files).some((f) => /header|footer/.test(f)), 'no setup: no header or footer');
});

test('Word: fonts, sizes and line spacing are kept', async () => {
  const JSZip = (await import('jszip')).default;
  const doc = { type: 'doc', content: [
    { type: 'paragraph', attrs: { lineHeight: '1.5' }, content: [{ type: 'text', text: 'Serif text', marks: [{ type: 'textStyle', attrs: { fontFamily: 'Georgia, serif', fontSize: '14pt' } }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Plain', marks: [{ type: 'textStyle', attrs: { fontFamily: 'serif', fontSize: '24px' } }] }] },
  ] };
  const xml = await (await JSZip.loadAsync(await wordFromDoc(doc, 'Fonts'))).file('word/document.xml').async('string');
  assert.match(xml, /<w:spacing w:line="360" w:lineRule="auto"\/>/);
  assert.match(xml, /<w:rFonts w:ascii="Georgia"/);
  assert.match(xml, /<w:sz w:val="28"\/>/);
  assert.match(xml, /<w:sz w:val="36"\/>/, '24px is 18pt');
});

test('Excel: a filter becomes an AutoFilter with its rows hidden, and comes back', async () => {
  const data = { sheets: [{ name: 'Jobs', cells: { A1: 'Job', B1: 'Status', A2: 'Logo', B2: 'Done', A3: 'Site', B3: 'Open', A4: 'Ads', B4: 'Done', A5: 'Sum', B5: '=A1' }, filter: { range: 'A1:B4', hidden: { B: ['Done'] } } }] };
  const buf = await excelFromSheet(data);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  assert.deepEqual([2, 3, 4, 5].map((r) => !!ws.getRow(r).hidden), [true, false, true, false]);
  const back = (await sheetFromExcel(buf)).sheets[0];
  assert.deepEqual(back.filter, { range: 'A1:B4', hidden: {} });
  assert.equal(back.hide, undefined, 'rows the filter hid are not hidden by hand');
});

test('Excel: rows a filter condition leaves out are hidden in the download', async () => {
  const data = { sheets: [{ name: 'Costs', cells: { A1: 'Item', B1: 'Cost', A2: 'Pens', B2: '4', A3: 'Desk', B3: '250', A4: 'Lamp', B4: '40', A5: 'Sum', B5: '=B2' }, filter: { range: 'A1:B5', hidden: {}, cond: { B: { op: 'gt', a: '10' } } } }] };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await excelFromSheet(data));
  assert.deepEqual([2, 3, 4, 5].map((r) => !!wb.worksheets[0].getRow(r).hidden), [true, false, false, false], 'formula rows stay shown');
});

test('Excel: alternating colours become cell fills, a cell\'s own fill kept', async () => {
  const data = { sheets: [{ name: 'S', cells: { A1: 'Item', B1: 'Cost', A2: 'Pens', A3: 'Desk', A4: 'Lamp' }, formats: { B3: { fill: '#ff0000' } }, bands: [{ id: 'b', range: 'A1:B4', header: true, footer: false, head: '#4a86e8', odd: '#ffffff', even: '#e8f0fe', foot: '#c6dafc' }] }] };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await excelFromSheet(data));
  const ws = wb.worksheets[0];
  const fill = (k) => ws.getCell(k).fill?.fgColor?.argb;
  assert.deepEqual(['A1', 'A2', 'A3', 'B3', 'A4'].map(fill), ['FF4A86E8', 'FFFFFFFF', 'FFE8F0FE', 'FFFF0000', 'FFFFFFFF']);
  assert.equal(ws.getCell('B1').font?.bold, true);
});

test('PowerPoint: rotated boxes keep their angle both ways', async () => {
  const deck = { theme: 'light', slides: [{ id: 's', items: [
    { id: 'a', type: 'text', text: 'Tilted', x: 10, y: 10, w: 30, h: 10, rot: 45 },
    { id: 'b', type: 'shape', shape: 'rect', fill: '#ff0000', x: 50, y: 50, w: 10, h: 10, rot: -30 },
    { id: 'c', type: 'text', text: 'Straight', x: 10, y: 60, w: 30, h: 10 }] }] };
  const buf = await powerPointFromDeck(deck, {});
  const xml = await (await (await import('jszip')).default.loadAsync(buf)).file('ppt/slides/slide1.xml').async('string');
  assert.match(xml, /rot="2700000"/, '45° in 60000ths');
  assert.match(xml, /rot="19800000"/, '-30° written as 330°');
  const items = (await deckFromPowerPoint(buf, { savePicture: async () => 'x' })).slides[0].items;
  assert.equal(items.find((i) => i.text === 'Tilted').rot, 45);
  assert.equal(items.find((i) => i.type === 'shape').rot, -30);
  assert.equal(items.find((i) => i.text === 'Straight').rot, undefined);
});

test('Excel: newer functions carry the _xlfn. prefix in the file and lose it in Sheets', async () => {
  assert.equal(formulaToExcel('IFERROR(XLOOKUP(A1,B:B,C:C),"_xlfn.x")+STDEV.S(D1:D3)+SUM(E1)'), 'IFERROR(_xlfn.XLOOKUP(A1,B:B,C:C),"_xlfn.x")+_xlfn.STDEV.S(D1:D3)+SUM(E1)');
  assert.equal(formulaFromExcel('_xlfn.XLOOKUP(A1,B1:B3,C1:C3)&"_xlfn."'), 'XLOOKUP(A1,B1:B3,C1:C3)&"_xlfn."');
  const data = { sheets: [{ name: 'S', cells: { A1: '1', B1: '=XLOOKUP(1,A1:A1,A1:A1)', B2: '=STDEV.P(A1:A2)' } }] };
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await excelFromSheet(data));
  assert.equal(wb.worksheets[0].getCell('B1').value.formula, '_xlfn.XLOOKUP(1,A1:A1,A1:A1)');
  const back = (await sheetFromExcel(await excelFromSheet(data))).sheets[0];
  assert.equal(back.cells.B1, '=XLOOKUP(1,A1:A1,A1:A1)');
  assert.equal(back.cells.B2, '=STDEV.P(A1:A2)');
});

test('Word: a table of contents becomes links to bookmarked headings, and opens again as plain headings', async () => {
  const JSZip = (await import('jszip')).default;
  const doc = { type: 'doc', content: [
    { type: 'tableOfContents' },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Budget' }] },
    { type: 'heading', attrs: { level: 3 } },
    { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] },
  ] };
  const buf = await wordFromDoc(doc, 'Contents');
  const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
  assert.match(xml, /<w:bookmarkStart[^>]*w:name="toc_1"/);
  assert.match(xml, /<w:bookmarkStart[^>]*w:name="toc_2"/);
  assert.doesNotMatch(xml, /toc_3/);
  assert.match(xml, /<w:hyperlink[^>]*w:anchor="toc_2"[^>]*>[\s\S]*?Budget/);
  assert.match(xml, /<w:ind w:left="360"/); // Budget indented under Plan
  const back = (await docFromWord(buf)).doc;
  const headings = back.content.filter((n) => n.type === 'heading').map((n) => n.content?.map((t) => t.text).join(''));
  assert.deepEqual(headings.filter(Boolean), ['Plan', 'Budget']);
  // Without a contents block, headings aren't bookmarked.
  const plain = await (await JSZip.loadAsync(await wordFromDoc({ type: 'doc', content: doc.content.slice(1) }, 'x'))).file('word/document.xml').async('string');
  assert.doesNotMatch(plain, /w:hyperlink/);
});

test('PowerPoint: hidden slides stay skipped both ways; transitions are read', async () => {
  const JSZip = (await import('jszip')).default;
  const deck = { theme: 'light', slides: [
    { id: 'a', items: [{ id: 't', type: 'text', role: 'title', text: 'Shown', x: 10, y: 10, w: 80, h: 20, size: 60 }], transition: 'fade' },
    { id: 'b', items: [{ id: 'u', type: 'text', role: 'title', text: 'Backup', x: 10, y: 10, w: 80, h: 20, size: 60 }], skip: true },
  ] };
  const buf = await powerPointFromDeck(deck, 'Deck');
  const zip = await JSZip.loadAsync(buf);
  assert.match(await zip.file('ppt/slides/slide2.xml').async('string'), /<p:sld[^>]* show="0"/);
  assert.doesNotMatch(await zip.file('ppt/slides/slide1.xml').async('string'), /show="0"/);
  // The slide's transition goes out too; change it to another the way PowerPoint writes it, then read the file back.
  const s1 = await zip.file('ppt/slides/slide1.xml').async('string');
  assert.match(s1, /<p:transition spd="med"><p:fade\/><\/p:transition>/);
  zip.file('ppt/slides/slide1.xml', s1.replace('<p:fade/>', '<p:push dir="u"/>'));
  const back = await deckFromPowerPoint(await zip.generateAsync({ type: 'nodebuffer' }), { savePicture: async () => 'x' });
  assert.deepEqual(back.slides.map((s) => [s.items[0]?.text, s.transition || null, !!s.skip]), [['Shown', 'push', false], ['Backup', null, true]]);
});

test('Excel: strikethrough, wrapped text and borders go out and come back', async () => {
  const data = { sheets: [{ name: 'S', cells: { A1: 'Old', B1: 'A long note that wraps', C1: '1' }, formats: { A1: { s: 1 }, B1: { wrap: 1, align: 'center' }, C1: { bd: 'tblr' }, C2: { bd: 'b' } } }] };
  const back = (await sheetFromExcel(await excelFromSheet(data))).sheets[0];
  assert.deepEqual(back.formats.A1, { s: 1 });
  assert.deepEqual(back.formats.B1, { wrap: 1, align: 'center' });
  assert.equal(back.formats.C1.bd, 'tblr');
  assert.equal(back.formats.C2.bd, 'b');
});

test('Word: a checklist gets boxes, ticked or not, and nested items indented', async () => {
  const JSZip = (await import('jszip')).default;
  const item = (checked, text, extra = []) => ({ type: 'taskItem', attrs: { checked }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }, ...extra] });
  const doc = { type: 'doc', content: [{ type: 'taskList', content: [
    item(true, 'Book the room'),
    item(false, 'Send the agenda', [{ type: 'taskList', content: [item(false, 'Ask Kim for numbers')] }]),
  ] }] };
  const xml = await (await JSZip.loadAsync(await wordFromDoc(doc, 'List'))).file('word/document.xml').async('string');
  const text = xml.replace(/<[^>]+>/g, '');
  assert.match(text, /☑ Book the room/);
  assert.match(text, /☐ Send the agenda/);
  assert.match(text, /☐ Ask Kim for numbers/);
  assert.match(xml, /<w:ind w:left="720" w:hanging="280"\/>/, 'the nested one is indented further');
});

test('Word: boxed paragraphs come back as a checklist', async () => {
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
    { type: 'taskList', content: [
      { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Done thing' }] }] },
      { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Open thing' }] }] },
    ] },
  ] };
  const back = (await docFromWord(await wordFromDoc(doc, 'x'))).doc;
  assert.equal(back.content[0].type, 'paragraph');
  const list = back.content.find((n) => n.type === 'taskList');
  assert.deepEqual(list.content.map((i) => [i.attrs.checked, i.content[0].content.map((t) => t.text).join('')]), [[true, 'Done thing'], [false, 'Open thing']]);
});

test('Word: a page break is a real page break', async () => {
  const JSZip = (await import('jszip')).default;
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Cover' }] },
    { type: 'pageBreak' },
    { type: 'paragraph', content: [{ type: 'text', text: 'Chapter one' }] },
  ] };
  const xml = await (await JSZip.loadAsync(await wordFromDoc(doc, 'Book'))).file('word/document.xml').async('string');
  assert.match(xml, /Cover[\s\S]*<w:br w:type="page"\/>[\s\S]*Chapter one/);
});

test('Excel: merged cells go out and come back', async () => {
  const data = { sheets: [{ name: 'S', cells: { A1: 'Quarterly report', B3: 'x', A5: '1' }, merges: ['A1:D1', 'B3:C4'] }] };
  const back = (await sheetFromExcel(await excelFromSheet(data))).sheets[0];
  assert.deepEqual(back.merges.sort(), ['A1:D1', 'B3:C4']);
  assert.equal(back.cells.A1, 'Quarterly report');
  assert.equal(back.cells.A5, '1');
  const plain = (await sheetFromExcel(await excelFromSheet({ sheets: [{ name: 'S', cells: { A1: '1' } }] }))).sheets[0];
  assert.equal(plain.merges, undefined);
});

test('Excel: dates are real dates, and date formats go both ways', async () => {
  const data = { sheets: [{ name: 'S', cells: { A1: '2026-11-07', A2: '2026-12-25', A3: '2027-01-02', A4: 'not a date' }, formats: { A2: { num: 'date' }, A3: { num: 'date', ds: 'long' } } }] };
  const buf = await excelFromSheet(data);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  assert.ok(ws.getCell('A1').value instanceof Date, 'a date, not text');
  assert.equal(ws.getCell('A2').numFmt, 'd mmm yyyy');
  assert.equal(ws.getCell('A3').numFmt, 'dddd, d mmmm yyyy');
  const back = (await sheetFromExcel(buf)).sheets[0];
  assert.deepEqual([back.cells.A1, back.cells.A2, back.cells.A3, back.cells.A4], ['2026-11-07', '2026-12-25', '2027-01-02', 'not a date']);
  assert.deepEqual(back.formats.A2, { num: 'date' });
  assert.deepEqual(back.formats.A3, { num: 'date', ds: 'long' });
  assert.deepEqual(back.formats.A1, { num: 'date', ds: 'iso' }, 'shown as typed');
  assert.deepEqual(numFromExcel('dd/mm/yyyy'), { num: 'date', ds: 'short' });
  assert.deepEqual(numFromExcel('mmm yyyy'), { num: 'date', ds: 'month' });
  assert.deepEqual(numFromExcel('#,##0.00'), { num: 'number', dp: 2 });
});

test('PowerPoint: lines and arrows go out and come back, with their direction and colour', async () => {
  const deck = { theme: 'light', slides: [{ id: 'a', items: [
    { id: 'l', type: 'shape', shape: 'line', dir: 'h', x: 10, y: 20, w: 40, h: 8, fill: '#c5221f' },
    { id: 'r', type: 'shape', shape: 'arrow', dir: 'u', x: 50, y: 50, w: 30, h: 30, fill: 'accent' },
    { id: 'v', type: 'shape', shape: 'arrow', dir: 'v', x: 80, y: 10, w: 4, h: 30 },
  ] }] };
  const back = await deckFromPowerPoint(await powerPointFromDeck(deck, 'Lines'), { savePicture: async () => 'x' });
  const items = back.slides[0].items;
  assert.deepEqual(items.map((i) => [i.shape, i.dir]), [['line', 'h'], ['arrow', 'u'], ['arrow', 'v']]);
  assert.equal(items[0].fill, '#c5221f');
  assert.ok(Math.abs(items[1].x - 50) < 1 && Math.abs(items[1].w - 30) < 1);
});

test('Excel: hidden rows and columns go out and come back', async () => {
  const data = { sheets: [{ name: 'S', cells: { A1: 'a', B2: 'b', C6: 'c' }, colWidths: { C: 150 }, hide: { rows: [1, 3], cols: [2] } }] };
  const back = (await sheetFromExcel(await excelFromSheet(data))).sheets[0];
  assert.deepEqual(back.hide, { rows: [1, 3], cols: [2] });
  assert.equal(back.cells.B2, 'b');
  const plain = (await sheetFromExcel(await excelFromSheet({ sheets: [{ name: 'S', cells: { A1: '1' } }] }))).sheets[0];
  assert.equal(plain.hide, undefined);
});

test('Word: footnotes go out as real footnotes and come back as markers with their notes', async () => {
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Sales grew' }, { type: 'footnote', attrs: { note: 'Source: Q3 report & "notes"' } }, { type: 'text', text: ' fast.' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Costs' }, { type: 'footnote', attrs: { note: 'Before tax' } }] }] }] },
  ] };
  const buf = await wordFromDoc(doc, 'Report');
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/footnotes.xml').async('string');
  assert.match(xml, /Source: Q3 report &amp; &quot;notes&quot;|Source: Q3 report &amp; "notes"/);
  assert.match(xml, /Before tax/);
  assert.match(await zip.file('word/document.xml').async('string'), /w:footnoteReference w:id="1"/);
  const back = (await docFromWord(buf)).doc;
  const p = back.content[0].content;
  assert.deepEqual(p.map((n) => n.type), ['text', 'footnote', 'text']);
  assert.equal(p[1].attrs.note, 'Source: Q3 report & "notes"');
  assert.equal(JSON.stringify(back).includes('↑'), false, 'no list of notes left at the end');
  assert.ok(JSON.stringify(back).includes('"note":"Before tax"'));
  // Without footnotes nothing changes.
  const none = await JSZip.loadAsync(await wordFromDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }));
  assert.ok(!(await none.file('word/document.xml').async('string')).includes('footnoteReference'));
});

test('PowerPoint: tables go out and come back, with their cells and heading row', async () => {
  const deck = { theme: 'light', slides: [{ id: 's1', items: [
    { id: 't1', type: 'table', x: 10, y: 20, w: 60, h: 30, size: 18, header: true, cells: [['Region', 'Sales'], ['North', '120'], ['South & West', '95']] },
  ] }] };
  const buf = await powerPointFromDeck(deck);
  const back = await deckFromPowerPoint(buf, { savePicture: async () => 'x' });
  const t = back.slides[0].items.find((i) => i.type === 'table');
  assert.ok(t, JSON.stringify(back.slides[0].items));
  assert.deepEqual(t.cells, [['Region', 'Sales'], ['North', '120'], ['South & West', '95']]);
  assert.equal(t.header, true);
  assert.ok(Math.abs(t.x - 10) < 1 && Math.abs(t.w - 60) < 1, `${t.x} ${t.w}`);
  assert.ok(Math.abs(t.size - 18) <= 1, String(t.size));
});

test('excel: named ranges both ways', async () => {
  const data = { sheets: [{ name: 'Data', cells: { A1: '1', A2: '2', C1: '=SUM(Sales)*Tax' }, names: { Sales: 'A1:A2', Tax: 'B1' } }, { name: "Bob's", cells: { A1: 'x' }, names: { Other: 'C3' } }] };
  const back = await sheetFromExcel(await excelFromSheet(data));
  assert.deepEqual(back.sheets[0].names, { Sales: 'A1:A2', Tax: 'B1' });
  assert.deepEqual(back.sheets[1].names, { Other: 'C3' });
  assert.equal(back.sheets[0].cells.C1, '=SUM(Sales)*Tax');
});

test('excel: formulas that refer to other sheets', async () => {
  const data = { sheets: [{ name: 'Summary', cells: { A1: "=SUM('Q1 data'!B1:B2)+Other!A1" } }, { name: 'Q1 data', cells: { B1: '1', B2: '2' } }, { name: 'Other', cells: { A1: '3' } }] };
  const back = await sheetFromExcel(await excelFromSheet(data));
  assert.equal(back.sheets[0].cells.A1, "=SUM('Q1 data'!B1:B2)+Other!A1");
});

test('Excel: FILTER, SORT, UNIQUE and SEQUENCE carry their prefixes in the file and lose them in Sheets', () => {
  const f = 'SUM(FILTER(A1:A9,B1:B9>5))+COUNTA(UNIQUE(SORT(C1:C9)))+SUM(SEQUENCE(3))&"FILTER("';
  const x = formulaToExcel(f);
  assert.equal(x, 'SUM(_xlfn._xlws.FILTER(A1:A9,B1:B9>5))+COUNTA(_xlfn.UNIQUE(_xlfn._xlws.SORT(C1:C9)))+SUM(_xlfn.SEQUENCE(3))&"FILTER("');
  assert.equal(formulaFromExcel(x), f);
});

test('PowerPoint: a chart from a spreadsheet on a slide becomes a real chart with its figures', async () => {
  const deck = { theme: 'light', slides: [{ id: 's1', items: [
    { id: 'c', type: 'chart', x: 10, y: 10, w: 80, h: 70, title: 'Sales by month', chartType: 'column', fileId: 'f1', chartId: 'x',
      data: { categories: ['Jan', 'Feb'], series: [{ name: 'Sales', values: [10, null] }, { name: 'Costs', values: [4, 6] }] } },
    { id: 'p', type: 'chart', x: 0, y: 0, w: 10, h: 10, chartType: 'pie', data: { categories: ['A'], series: [{ name: 'S', values: [1] }] } },
    { id: 'e', type: 'chart', x: 0, y: 0, w: 10, h: 10, chartType: 'line', data: { categories: [], series: [] } },
  ] }] };
  const buf = await powerPointFromDeck(deck);
  const zip = await JSZip.loadAsync(buf);
  const charts = Object.keys(zip.files).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n));
  assert.equal(charts.length, 2, 'one per chart with figures');
  const xml = (await Promise.all(charts.map((n) => zip.file(n).async('string')))).join('');
  assert.match(xml, /Sales by month/);
  assert.match(xml, /barDir val="col"/);
  assert.match(xml, /<c:pieChart>/);
  assert.match(xml, /Feb/);
});

test('Docs: a chart from Sheets is its title and a table of its figures in Word and Markdown', async () => {
  const { markdownFromDoc } = await import('../src/office/markdown.js');
  const data = JSON.stringify({ categories: ['Jan', 'Feb'], series: [{ name: 'Sales', values: [10, null] }, { name: 'Costs|net', values: [4, 6] }] });
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Before' }] }, { type: 'sheetChart', attrs: { fileId: 'f', chartId: 'c', title: 'Sales by month', chartType: 'line', data } }] };
  const md = markdownFromDoc(doc);
  assert.match(md, /\*\*Sales by month\*\*\n\n\|  \| Sales \| Costs\\\|net \|\n\| --- \| --- \| --- \|\n\| Jan \| 10 \| 4 \|\n\| Feb \|  \| 6 \|/);
  const buf = await wordFromDoc(doc, 'Report');
  const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
  for (const t of ['Sales by month', 'Sales', 'Jan', 'Feb', '10', '6']) assert.ok(xml.includes(`>${t}<`), t);
  assert.match(xml, /<w:tbl>/);
});

test('Excel: HYPERLINK cells keep their formula both ways', async () => {
  const sheet = { sheets: [{ name: 'Links', cells: { A1: '=HYPERLINK("https://acme.com", "Acme")', A2: '=SPARKLINE(B1:B3)' } }] };
  const buf = await excelFromSheet(sheet);
  const back = await sheetFromExcel(buf);
  assert.equal(back.sheets[0].cells.A1, '=HYPERLINK("https://acme.com", "Acme")');
});

test('Excel: grouped rows and columns are outline levels both ways, collapsed ones hidden', async () => {
  const sheet = { sheets: [{ name: 'Plan', cells: { A1: 'Total', A2: 'a', A3: 'b', A4: 'c', D1: 'x' }, groups: [{ axis: 'col', from: 1, to: 2, collapsed: false }, { axis: 'row', from: 1, to: 3, collapsed: true }] }] };
  const buf = await excelFromSheet(sheet);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  assert.equal(ws.getRow(2).outlineLevel, 1); assert.equal(ws.getRow(2).hidden, true);
  assert.equal(ws.getColumn(2).outlineLevel, 1); assert.ok(!ws.getColumn(2).hidden);
  const back = (await sheetFromExcel(buf)).sheets[0];
  assert.deepEqual(back.groups, [{ axis: 'row', from: 1, to: 3, collapsed: true }, { axis: 'col', from: 1, to: 2, collapsed: false }]);
  assert.equal(back.hide, undefined, 'not hidden by hand');
});

test('PowerPoint: slide numbers (every slide, or all but the first) go out and come back', async () => {
  const { numberShown } = await import('../src/office/powerpoint.js');
  const three = (numbers) => ({ theme: 'light', ...(numbers && { numbers }), slides: ['a', 'b', 'c'].map((id) => ({ id, items: [{ id: `${id}t`, type: 'text', text: `Slide ${id}`, x: 10, y: 10, w: 50, h: 20 }] })) });
  assert.deepEqual([0, 1, 2].map((i) => numberShown(three('skip-first'), i)), [false, true, true]);
  assert.deepEqual([0, 1].map((i) => numberShown(three(null), i)), [false, false]);
  for (const numbers of [true, 'skip-first', null]) {
    const buf = await powerPointFromDeck(three(numbers));
    const back = await deckFromPowerPoint(buf, { savePicture: async () => 'x' });
    assert.equal(back.numbers, numbers ?? undefined, `numbers: ${numbers}`);
    assert.deepEqual(back.slides.map((s) => s.items.map((i) => i.text)), [['Slide a'], ['Slide b'], ['Slide c']], 'the number is not a text box');
  }
});

test('live co-editing keeps a presentation\'s slide numbers setting', async () => {
  const { deckDocFromJson, jsonFromDeckDoc, applyDeckJson } = await import('../src/collabdoc.js');
  const doc = deckDocFromJson({ theme: 'dark', numbers: 'skip-first', slides: [{ id: 'a', items: [] }] });
  assert.equal(jsonFromDeckDoc(doc).numbers, 'skip-first');
  applyDeckJson(doc, { theme: 'dark', numbers: true, slides: [{ id: 'a', items: [] }] });
  assert.equal(jsonFromDeckDoc(doc).numbers, true);
  applyDeckJson(doc, { theme: 'dark', slides: [{ id: 'a', items: [] }] });
  assert.equal('numbers' in jsonFromDeckDoc(doc), false);
});

test('Excel: newer functions are written with their _xlfn. prefix and read back plain', async () => {
  const { formulaToExcel, formulaFromExcel } = await import('../src/office/excel.js');
  for (const f of ['=XMATCH(5,A1:A9)', '=VSTACK(A1:A2,B1:B2)', '=HSTACK(A1,B1)', '=TAKE(A1:A9,2)', '=DROP(A1:A9,1)', '=ISOWEEKNUM(A1)']) {
    const x = formulaToExcel(f);
    assert.match(x, /_xlfn\./, f);
    assert.equal(formulaFromExcel(x), f);
  }
  assert.equal(formulaToExcel('=REGEXMATCH(A1,"x")'), '=REGEXMATCH(A1,"x")', 'not an Excel function: left as it is');
  assert.equal(formulaToExcel('="XMATCH(1)"&A1'), '="XMATCH(1)"&A1', 'text stays text');
});

test('dropdown chips: their choice in Word (shaded in its colour), Markdown and search', async () => {
  const { markdownFromDoc } = await import('../src/office/markdown.js');
  const { docText } = await import('../src/search.js');
  const JSZip = (await import('jszip')).default;
  const options = [{ label: 'Not started', color: 'grey' }, { label: 'In progress', color: 'blue' }, { label: 'Done', color: 'green' }];
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'Status: ' }, { type: 'dropchip', attrs: { options, value: 'In progress' } },
    { type: 'text', text: ' then ' }, { type: 'dropchip', attrs: { options, value: null } },
    { type: 'text', text: ' and ' }, { type: 'dropchip', attrs: { options: [], value: 'x' } },
  ] }] };
  assert.equal(markdownFromDoc(doc).trim(), 'Status: **In progress** then **Not started** and **—**');
  assert.match(docText(doc), /Status: +In progress +then +Not started/);
  const xml = await (await JSZip.loadAsync(await wordFromDoc(doc, 'Chips'))).file('word/document.xml').async('string');
  assert.match(xml, /w:fill="D3E3FD"[\s\S]*?In progress/, 'the chosen colour shades the text');
  assert.match(xml, /w:fill="E8EAED"[\s\S]*?Not started/, 'nothing picked yet is grey');
});

test('newer statistics functions get Excel\'s prefix both ways; older ones stay plain', () => {
  assert.equal(formulaToExcel('=FORECAST.LINEAR(6,B1:B5,A1:A5)+PERCENTILE.INC(A1:A5,0.9)'), '=_xlfn.FORECAST.LINEAR(6,B1:B5,A1:A5)+_xlfn.PERCENTILE.INC(A1:A5,0.9)');
  assert.equal(formulaToExcel('=MODE.SNGL(A1:A9)&QUARTILE.INC(A1:A9,1)'), '=_xlfn.MODE.SNGL(A1:A9)&_xlfn.QUARTILE.INC(A1:A9,1)');
  assert.equal(formulaToExcel('=FORECAST(6,B1:B5,A1:A5)+MODE(A1:A9)+CORREL(A1:A5,B1:B5)+MROUND(A1,5)'), '=FORECAST(6,B1:B5,A1:A5)+MODE(A1:A9)+CORREL(A1:A5,B1:B5)+MROUND(A1,5)');
  assert.equal(formulaFromExcel('=_xlfn.FORECAST.LINEAR(6,B1:B5,A1:A5)'), '=FORECAST.LINEAR(6,B1:B5,A1:A5)');
});

test('LET and LAMBDA in Excel files: _xlfn. on the functions, _xlpm. on the names, and back', () => {
  const ours = '=LET(net, SUM(B1:B3), tax, net*0.2, IF(net>0, net+tax, "none"))';
  const xl = '=_xlfn.LET(_xlpm.net, SUM(B1:B3), _xlpm.tax, _xlpm.net*0.2, IF(_xlpm.net>0, _xlpm.net+_xlpm.tax, "none"))';
  assert.equal(formulaToExcel(ours), xl);
  assert.equal(formulaFromExcel(xl), ours);
  assert.equal(formulaToExcel('=BYROW(A1:B3, LAMBDA(row, SUM(row)*Rate))'), '=_xlfn.BYROW(A1:B3, _xlfn.LAMBDA(_xlpm.row, SUM(_xlpm.row)*Rate))', 'a named range is left alone');
  assert.equal(formulaToExcel('=MAP(A1:A3, LAMBDA(v, "v is " & v))'), '=_xlfn.MAP(A1:A3, _xlfn.LAMBDA(_xlpm.v, "v is " & _xlpm.v))', 'text is left alone');
  assert.equal(formulaToExcel('=SUM(Net)+Net!A1'), '=SUM(Net)+Net!A1', 'no LET: nothing changes');
});

test('named functions: Excel defined names holding a LAMBDA, both ways', async () => {
  const JSZip = (await import('jszip')).default;
  const data = { sheets: [{ name: 'Prices', cells: { A1: '100', B1: '=WITHTAX(A1)' }, names: { Rate: 'E1' } }], functions: [
    { name: 'WithTax', params: ['amount'], body: '=amount * (1 + Rate)', description: 'Adds sales tax & rounding' },
    { name: 'MARGIN', params: ['price', 'cost'], body: 'IF(price=0, "n/a", (price - cost) / price)' },
  ] };
  const buf = await excelFromSheet(data);
  const xml = await (await JSZip.loadAsync(buf)).file('xl/workbook.xml').async('string');
  assert.match(xml, /<definedName name="WITHTAX" comment="Adds sales tax &amp; rounding">_xlfn.LAMBDA\(_xlpm.amount, _xlpm.amount \* \(1 \+ Rate\)\)<\/definedName>/);
  assert.match(xml, /<definedName name="MARGIN">_xlfn.LAMBDA\(_xlpm.price, _xlpm.cost, IF\(_xlpm.price=0, &quot;n\/a&quot;, /);
  assert.match(xml, /<definedName name="Rate"/, 'named ranges are still there');
  const back = await sheetFromExcel(buf);
  assert.deepEqual(back.functions, [
    { name: 'WITHTAX', params: ['amount'], body: 'amount * (1 + Rate)', description: 'Adds sales tax & rounding' },
    { name: 'MARGIN', params: ['price', 'cost'], body: 'IF(price=0, "n/a", (price - cost) / price)' },
  ]);
  assert.equal(back.sheets[0].names.Rate, 'E1');
  assert.equal((await sheetFromExcel(await excelFromSheet({ sheets: data.sheets }))).functions, undefined, 'none: none');
});

test('date chips: the day in Word, Markdown and search (by its words or as 2026-11-09)', async () => {
  const { markdownFromDoc } = await import('../src/office/markdown.js');
  const { docText } = await import('../src/search.js');
  const JSZip = (await import('jszip')).default;
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'Due ' }, { type: 'datechip', attrs: { date: '2026-11-09' } },
    { type: 'text', text: ', review ' }, { type: 'datechip', attrs: { date: '2027-01-31' } }, { type: 'text', text: ', then ' }, { type: 'datechip', attrs: { date: 'soon' } },
  ] }] };
  assert.equal(markdownFromDoc(doc).trim(), 'Due 9 Nov 2026, review 31 Jan 2027, then No date');
  assert.match(docText(doc), /Due +9 Nov 2026 2026-11-09/);
  const xml = await (await JSZip.loadAsync(await wordFromDoc(doc, 'Dates'))).file('word/document.xml').async('string');
  assert.match(xml, /<w:t[^>]*>9 Nov 2026<\/w:t>/);
  assert.match(xml, /31 Jan 2027/);
});

test('equations: an equation in Word, its LaTeX in search', async () => {
  const { docText } = await import('../src/search.js');
  const JSZip = (await import('jszip')).default;
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Energy: ' }, { type: 'math', attrs: { latex: 'E=mc^2' } }] }] };
  assert.match(docText(doc), /Energy: +E=mc\^2/);
  const xml = await (await JSZip.loadAsync(await wordFromDoc(doc, 'Physics'))).file('word/document.xml').async('string');
  assert.match(xml, /<m:oMath>[\s\S]*E=mc\^2[\s\S]*<\/m:oMath>/, 'a Word equation');
});

test('PowerPoint: transitions, slides that move on by themselves, and looping, both ways', async () => {
  const JSZip = (await import('jszip')).default;
  const deck = { theme: 'light', loop: true, slides: [
    { id: 'a', items: [], advance: 8, transition: 'fade' },
    { id: 'b', items: [], transition: 'push' },
    { id: 'c', items: [] },
    { id: 'd', items: [], advance: 30 },
  ] };
  const buf = await powerPointFromDeck(deck, { pictureData: async () => null });
  const zip = await JSZip.loadAsync(buf);
  const slide = async (n) => zip.file(`ppt/slides/slide${n}.xml`).async('string');
  assert.match(await slide(1), /<\/p:clrMapOvr><p:transition spd="med" advTm="8000"><p:fade\/><\/p:transition>/);
  assert.match(await slide(2), /<p:transition spd="med"><p:push dir="u"\/><\/p:transition>/);
  assert.doesNotMatch(await slide(3), /p:transition/);
  assert.match(await slide(4), /advTm="30000"><\/p:transition>/);
  assert.match(await zip.file('ppt/presProps.xml').async('string'), /<p:presentationPr[^>]*><p:showPr loop="1"/);
  const back = await deckFromPowerPoint(buf, { savePicture: async () => 'x' });
  assert.equal(back.loop, true);
  assert.deepEqual(back.slides.map((s) => [s.transition || null, s.advance || null]), [['fade', 8], ['push', null], [null, null], [null, 30]]);
  // A deck without any of it is written as before.
  const plain = await JSZip.loadAsync(await powerPointFromDeck({ theme: 'light', slides: [{ id: 'p', items: [] }] }, { pictureData: async () => null }));
  assert.doesNotMatch(await plain.file('ppt/slides/slide1.xml').async('string'), /p:transition/);
  assert.equal((await deckFromPowerPoint(await powerPointFromDeck({ theme: 'light', slides: [{ id: 'p', items: [] }] }, {}), { savePicture: async () => 'x' })).loop, undefined);
});

test('watermarks: a Word watermark in every page header, read back from Word files', async () => {
  const JSZip = (await import('jszip')).default;
  const { watermarkOfWord } = await import('../src/office/word.js');
  const { readSetup } = await import('../src/pagesetup.js');
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Terms.' }] }] };
  const page = readSetup({ watermark: 'DRAFT "v2" & <final>' });
  const buf = await wordFromDoc(doc, 'Contract', { page });
  const zip = await JSZip.loadAsync(buf);
  const header = await zip.file('word/header1.xml').async('string');
  assert.match(header, /<w:hdr [^>]*xmlns:v="urn:schemas-microsoft-com:vml"/);
  assert.match(header, /<v:shape id="PowerPlusWaterMarkObject"[^>]*rotation:315[\s\S]*<v:textpath [^>]*string="DRAFT &quot;v2&quot; &amp; &lt;final&gt;"\/>/);
  assert.match(await zip.file('word/document.xml').async('string'), /<w:headerReference w:type="default"/, 'the section uses that header');
  assert.equal(await watermarkOfWord(buf), 'DRAFT "v2" & <final>');
  // With a header text too, both are there; without a watermark, no shape.
  const both = await (await JSZip.loadAsync(await wordFromDoc(doc, 'C', { page: readSetup({ header: 'Acme', watermark: 'CONFIDENTIAL' }) }))).file('word/header1.xml').async('string');
  assert.match(both, /Acme[\s\S]*string="CONFIDENTIAL"/);
  assert.equal(await watermarkOfWord(await wordFromDoc(doc, 'C', { page: readSetup({ header: 'Acme' }) })), '');
  assert.equal(await watermarkOfWord(Buffer.from('not a zip')), '');
  assert.throws(() => readSetup({ watermark: 'x'.repeat(41) }), /40 characters/);
  assert.equal(readSetup({}).watermark, '');
});

test('Excel: cell notes both ways (plain and rich-text notes), and found by search', async () => {
  const { docText, sheetText } = await import('../src/search.js');
  const data = { sheets: [{ name: 'Budget', cells: { A1: 'Rent', B1: '1200' }, notes: { B1: 'Up 5% from March\nAsk the landlord', C3: 'Empty cell, still noted' } }] };
  const back = (await sheetFromExcel(await excelFromSheet(data))).sheets[0];
  assert.deepEqual(back.notes, { B1: 'Up 5% from March\nAsk the landlord', C3: 'Empty cell, still noted' });
  // A note written by Excel itself as rich text.
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('S');
  ws.getCell('A2').value = 'x';
  ws.getCell('A2').note = { texts: [{ font: { bold: true }, text: 'Kim: ' }, { text: 'check this' }] };
  assert.deepEqual((await sheetFromExcel(Buffer.from(await wb.xlsx.writeBuffer()))).sheets[0].notes, { A2: 'Kim: check this' });
  assert.equal((await sheetFromExcel(await excelFromSheet({ sheets: [{ name: 'N', cells: { A1: '1' } }] }))).sheets[0].notes, undefined);
  assert.match(sheetText(data), /Ask the landlord/);
  assert.ok(docText);
});

test('Excel: row heights go out in points and come back in pixels', async () => {
  const book = { sheets: [{ name: 'Sheet1', cells: { A1: 'Tall', A3: 'Short' }, rowHeights: { 1: 80, 3: 16, 7: 120 } }] };
  const buf = await excelFromSheet(book);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Sheet1');
  assert.equal(ws.getRow(1).height, 60);
  assert.equal(ws.getRow(7).height, 90, 'an empty row keeps its height too');
  const back = await sheetFromExcel(buf);
  assert.deepEqual(back.sheets[0].rowHeights, { 1: 80, 3: 16, 7: 120 });
  const plain = await sheetFromExcel(await excelFromSheet({ sheets: [{ name: 'S', cells: { A1: 'x' } }] }));
  assert.equal(plain.sheets[0].rowHeights, undefined, 'no heights when none were set');
});

test('Excel: vertical alignment both ways', async () => {
  const buf = await excelFromSheet({ sheets: [{ name: 'S', cells: { A1: 'up', B1: 'down', C1: 'plain' }, formats: { A1: { va: 'top' }, B1: { va: 'bottom', align: 'right' } } }] });
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.equal(wb.getWorksheet('S').getCell('A1').alignment.vertical, 'top');
  const back = await sheetFromExcel(buf);
  assert.deepEqual(back.sheets[0].formats, { A1: { va: 'top' }, B1: { va: 'bottom', align: 'right' } });
});

test('Excel: custom number formats go out as written and come back', async () => {
  const code = '#,##0;[Red](#,##0);"Nil"';
  const buf = await excelFromSheet({ sheets: [{ name: 'S', cells: { A1: '-5', B1: '0.25', C1: '46335.5' }, formats: { A1: { num: 'custom', code }, B1: { num: 'percent', dp: 1 }, C1: { num: 'custom', code: 'hh:mm' } } }] });
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.equal(wb.getWorksheet('S').getCell('A1').numFmt, code);
  const back = await sheetFromExcel(buf);
  assert.deepEqual(back.sheets[0].formats.A1, { num: 'custom', code });
  assert.deepEqual(back.sheets[0].formats.B1, { num: 'percent', dp: 1 }, 'familiar ones stay familiar');
  assert.deepEqual(back.sheets[0].formats.C1, { num: 'custom', code: 'hh:mm' }, 'a time is no longer lost');
});

test('Excel: formulas that give a date get a date format', async () => {
  const { dateFormulaFormat } = await import('../src/office/excel.js');
  const cells = { A1: '2026-11-09', A2: '5', A3: '2026-11-09 08:00' };
  assert.equal(dateFormulaFormat('=A1+7', cells), 'yyyy-mm-dd');
  assert.equal(dateFormulaFormat('=A1-0.5', cells), 'yyyy-mm-dd hh:mm');
  assert.equal(dateFormulaFormat('=A3+1', cells), 'yyyy-mm-dd hh:mm');
  assert.equal(dateFormulaFormat('=A2+7', cells), null, 'a number cell');
  assert.equal(dateFormulaFormat('=TODAY()+1'), 'yyyy-mm-dd');
  assert.equal(dateFormulaFormat('=EDATE(A1, 3)'), 'yyyy-mm-dd');
  assert.equal(dateFormulaFormat('=DATE(YEAR(A1), 1, 1)'), 'yyyy-mm-dd');
  assert.equal(dateFormulaFormat('=NOW()'), 'yyyy-mm-dd hh:mm');
  assert.equal(dateFormulaFormat('=TODAY()-A1'), null, 'days between: a number');
  assert.equal(dateFormulaFormat('=DAYS(A1, TODAY())'), null);
  assert.equal(dateFormulaFormat('=SUM(A1:A3)'), null);
  const buf = await excelFromSheet({ sheets: [{ name: 'S', cells: { A1: '2026-11-09', B1: '=A1+7', C1: '=A1+7' }, formats: { C1: { num: 'custom', code: 'd mmm' } } }] });
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.equal(wb.getWorksheet('S').getCell('B1').numFmt, 'yyyy-mm-dd');
  assert.equal(wb.getWorksheet('S').getCell('C1').numFmt, 'd mmm', 'the cell’s own format wins');
});
