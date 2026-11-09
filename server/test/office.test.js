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
    { range: 'B1:B1', type: 'rule', check: { kind: 'whole', op: 'between', a: '1', b: '' }, strict: true },
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
  data.sheets[0].cells.B1 = 'Item'; // two headings the same: not a table, so painted
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
  assert.equal(formulaToExcel('TEXTAFTER(A1,"@")&SORTBY(B1:B3,C1:C3,-1)&DEC2BIN(5)&ROMAN(9)'), '_xlfn.TEXTAFTER(A1,"@")&_xlfn.SORTBY(B1:B3,C1:C3,-1)&DEC2BIN(5)&ROMAN(9)');
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

test('Excel: QUERY formulas (quotes and all) go to Excel and back as written', async () => {
  const q = '=QUERY(A1:C9, "select A, sum(C) where B = \'North\' and C > 0 group by A label sum(C) \'Total\'", 1)';
  const back = await sheetFromExcel(await excelFromSheet({ sheets: [{ name: 'Data', cells: { A1: 'Rep', E1: q, F1: '=SUM(QUERY(A2:C9, "select C"))' } }] }));
  assert.equal(back.sheets[0].cells.E1, q);
  assert.equal(back.sheets[0].cells.F1, '=SUM(QUERY(A2:C9, "select C"))');
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

test('PowerPoint: links on boxes (a web page or another slide) go out and come back', async () => {
  const { linkFor } = await import('../src/office/powerpoint.js');
  const slidesIn = [{ id: 's1' }, { id: 's2' }];
  assert.deepEqual(linkFor({ url: 'https://acme.com/orders' }, slidesIn), { url: 'https://acme.com/orders' });
  assert.deepEqual(linkFor({ slide: 's2' }, slidesIn), { slide: 2 });
  assert.equal(linkFor({ url: 'javascript:alert(1)' }, slidesIn), null);
  assert.equal(linkFor({ slide: 'gone' }, slidesIn), null);
  const deck = { theme: 'light', slides: [
    { id: 's1', items: [
      { id: 't', type: 'text', text: 'Order online\nToday', x: 10, y: 10, w: 50, h: 20, size: 24, link: { url: 'https://acme.com/orders' } },
      { id: 'b', type: 'shape', shape: 'rect', fill: 'accent', x: 10, y: 50, w: 20, h: 20, link: { slide: 's2' } },
      { id: 'p', type: 'text', text: 'Plain', x: 60, y: 50, w: 20, h: 10 },
    ] },
    { id: 's2', items: [{ id: 'u', type: 'text', text: 'Prices', x: 10, y: 10, w: 50, h: 20 }] },
  ] };
  const buf = await powerPointFromDeck(deck, { pictureData: async () => null });
  const back = await deckFromPowerPoint(buf, { savePicture: async () => 'x' });
  const [one, two] = back.slides;
  const t = one.items.find((x) => x.type === 'text' && x.text.startsWith('Order'));
  assert.deepEqual(t.link, { url: 'https://acme.com/orders' });
  assert.equal(t.text, 'Order online\nToday');
  assert.deepEqual(one.items.find((x) => x.type === 'shape').link, { slide: two.id }, 'to the second slide, by its new id');
  assert.equal(one.items.find((x) => x.text === 'Plain').link, undefined);
});

test('Excel: text rotation both ways', async () => {
  const formats = { A1: { rot: 'up' }, B1: { rot: 'down' }, C1: { rot: 'tiltup' }, D1: { rot: 'tiltdown' }, E1: { rot: 'stack' } };
  const buf = await excelFromSheet({ sheets: [{ name: 'S', cells: { A1: 'Up', B1: 'Down', C1: 'Tilt', D1: 'Tilt', E1: 'Stack' }, formats }] });
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.equal(wb.getWorksheet('S').getCell('C1').alignment.textRotation, 45);
  const back = await sheetFromExcel(buf);
  assert.deepEqual(back.sheets[0].formats, formats);
});

test('Word and Markdown: superscript and subscript go out and come back (footnotes stay footnotes)', async () => {
  const { markdownFromDoc, docFromMarkdown } = await import('../src/office/markdown.js');
  const run = (text, mark) => ({ type: 'text', text, ...(mark && { marks: [{ type: mark }] }) });
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [run('E = mc'), run('2', 'superscript'), run(' and H'), run('2', 'subscript'), run('O'), { type: 'footnote', attrs: { note: 'Einstein, 1905' } }] }] };
  const { doc: back } = await docFromWord(await wordFromDoc(doc, 'Physics'), {});
  const texts = back.content[0].content;
  const marked = (name) => texts.filter((n) => n.marks?.some((m) => m.type === name)).map((n) => n.text);
  assert.deepEqual(marked('superscript'), ['2']);
  assert.deepEqual(marked('subscript'), ['2']);
  assert.ok(JSON.stringify(back).includes('"footnote"'), 'the footnote is still a footnote');
  const md = markdownFromDoc(doc);
  assert.match(md, /E = mc<sup>2<\/sup> and H<sub>2<\/sub>O/);
  const fromMd = docFromMarkdown(md);
  assert.ok(JSON.stringify(fromMd).includes('"superscript"') && JSON.stringify(fromMd).includes('"subscript"'));
});

test('Word: indented paragraphs and headings keep their indent', async () => {
  const JSZip = (await import('jszip')).default;
  const doc = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2, indent: 1 }, content: [{ type: 'text', text: 'Indented heading' }] },
    { type: 'paragraph', attrs: { indent: 2 }, content: [{ type: 'text', text: 'Twice in' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'At the margin' }] },
  ] };
  const xml = await (await JSZip.loadAsync(await wordFromDoc(doc, 'Indents'))).file('word/document.xml').async('string');
  const paraOf = (text) => xml.split('<w:p>').concat(xml.split('<w:p ')).find((p) => p.includes(text)) || '';
  assert.match(paraOf('Twice in'), /<w:ind w:left="1440"/);
  assert.match(paraOf('Indented heading'), /<w:ind w:left="720"/);
  assert.doesNotMatch(paraOf('At the margin'), /<w:ind /);
});

test('Word: bookmarks and links to them go out as Word bookmarks and internal links, and come back', async () => {
  const JSZipLib = (await import('jszip')).default;
  const link = (text, href) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] });
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'See ' }, link('the terms', 'https://ws.example/docs/abc#bm-terms123'), { type: 'text', text: ' or ' }, link('elsewhere', 'https://example.com/#bm-zzzzzz99')] },
    { type: 'paragraph', content: [{ type: 'bookmark', attrs: { id: 'terms123' } }, { type: 'text', text: 'Terms: pay in 30 days.' }] },
    { type: 'paragraph', content: [{ type: 'bookmark', attrs: { id: 'bad id!' } }, { type: 'text', text: 'End.' }] },
  ] };
  const buf = await wordFromDoc(doc, 'Contract');
  const xml = await (await JSZipLib.loadAsync(buf)).file('word/document.xml').async('string');
  assert.match(xml, /<w:bookmarkStart [^>]*w:name="bm_terms123"/);
  assert.match(xml, /<w:hyperlink [^>]*w:anchor="bm_terms123"/, 'a link to a bookmark in this document stays inside it');
  assert.equal((xml.match(/w:bookmarkStart [^>]*w:name="bm_/g) || []).length, 1, 'only good ids');
  const { doc: back } = await docFromWord(buf);
  const flat = JSON.stringify(back);
  assert.match(flat, /"type":"bookmark","attrs":\{"id":"terms123"\}/);
  assert.match(flat, /"href":"#bm-terms123"/);
  assert.match(flat, /"href":"https:\/\/example.com\/#bm-zzzzzz99"/, 'other sites\' links are left alone');

  // Word's own bookmarks (named by people) come in too; Word's housekeeping ones don't.
  const { Document, Packer, Paragraph, Bookmark, InternalHyperlink, TextRun } = await import('docx');
  const w = new Document({ sections: [{ children: [
    new Paragraph({ children: [new InternalHyperlink({ anchor: 'Appendix', children: [new TextRun('Go')] })] }),
    new Paragraph({ children: [new Bookmark({ id: 'Appendix', children: [new TextRun('Appendix A')] }), new Bookmark({ id: '_GoBack', children: [] })] }),
  ] }] });
  const { doc: theirs } = await docFromWord(await Packer.toBuffer(w));
  const marks = [];
  (function find(n) { if (n.type === 'bookmark') marks.push(n.attrs.id); (n.content || []).forEach(find); })(theirs);
  assert.equal(marks.length, 1, JSON.stringify(theirs));
  assert.match(marks[0], /^w[0-9a-f]{9}$/);
  assert.match(JSON.stringify(theirs), new RegExp(`"href":"#bm-${marks[0]}"`));
});

test('Word: links to a heading in the document become links inside the Word file', async () => {
  const JSZipLib = (await import('jszip')).default;
  const link = (text, href) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] });
  const h = (text) => ({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] });
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [link('costs', '#budget-costs'), { type: 'text', text: ' ' }, link('second notes', '#notes-2'), { type: 'text', text: ' ' }, link('nowhere', '#missing')] },
    h('Budget & Costs'), h('Notes'), h('Notes'),
  ] };
  const xml = await (await JSZipLib.loadAsync(await wordFromDoc(doc, 'Plan'))).file('word/document.xml').async('string');
  assert.match(xml, /<w:hyperlink [^>]*w:anchor="toc_1"/);
  assert.match(xml, /<w:hyperlink [^>]*w:anchor="toc_3"/, 'the second "Notes"');
  assert.equal((xml.match(/w:anchor=/g) || []).length, 2, 'a link to no heading stays as it was');
  assert.match(xml, /<w:bookmarkStart [^>]*w:name="toc_3"/);
});

test('columns: text in two or three columns goes to Word and comes back from Word files', async () => {
  const JSZip = (await import('jszip')).default;
  const { layoutOfWord } = await import('../src/office/word.js');
  const columnsOfWord = async (b) => (await layoutOfWord(b)).columns;
  const { readSetup } = await import('../src/pagesetup.js');
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Newsletter.' }] }] };
  const buf = await wordFromDoc(doc, 'News', { page: readSetup({ columns: 2 }) });
  const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
  assert.match(xml, /<w:cols [^>]*w:num="2"/);
  assert.match(xml, /<w:cols [^>]*w:space="720"/);
  assert.equal(await columnsOfWord(buf), 2);
  assert.equal(await columnsOfWord(await wordFromDoc(doc, 'News', { page: readSetup({ columns: 3 }) })), 3);
  assert.equal(await columnsOfWord(await wordFromDoc(doc, 'News', { page: readSetup({}) })), 1);
  assert.equal(await columnsOfWord(Buffer.from('not a zip')), 1);
  // Kept only when more than one; anything else refused.
  assert.equal(readSetup({ columns: 1 }).columns, undefined);
  assert.equal(readSetup({ columns: 3 }).columns, 3);
  for (const bad of [0, 4, 2.5, '2']) assert.throws(() => readSetup({ columns: bad }), /Columns: 1 to 3/);
});

test('line numbers: numbered lines go to Word and come back from Word files', async () => {
  const JSZip = (await import('jszip')).default;
  const { layoutOfWord } = await import('../src/office/word.js');
  const { readSetup } = await import('../src/pagesetup.js');
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Clause one.' }] }] };
  const buf = await wordFromDoc(doc, 'Contract', { page: readSetup({ lineNumbers: true, columns: 2 }) });
  const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
  assert.match(xml, /<w:lnNumType [^>]*w:countBy="1"[^>]*w:restart="continuous"/);
  assert.deepEqual(await layoutOfWord(buf), { columns: 2, lineNumbers: true });
  assert.deepEqual(await layoutOfWord(await wordFromDoc(doc, 'C', { page: readSetup({}) })), { columns: 1, lineNumbers: false });
  assert.equal(readSetup({ lineNumbers: true }).lineNumbers, true);
  assert.equal(readSetup({ lineNumbers: 'yes' }).lineNumbers, undefined, 'only true turns them on');
  assert.equal(readSetup({}).lineNumbers, undefined);
});

test('PowerPoint: a picture behind a slide goes out and comes back; a colour stays a colour', async () => {
  const deck = { theme: 'light', slides: [
    { id: 'a', bg: '#fde293', bgImage: 'bgpic', items: [{ id: 't', type: 'text', role: 'title', text: 'Welcome', x: 10, y: 10, w: 80, h: 20, size: 40 }] },
    { id: 'b', bg: '#c4eed0', items: [] },
    { id: 'c', bgImage: 'gone', items: [] },
  ] };
  const asked = [];
  const buf = await powerPointFromDeck(deck, { pictureData: async (id) => { asked.push(id); return id === 'bgpic' ? { data: PNG, mime: 'image/png' } : null; } });
  assert.deepEqual(asked, ['bgpic', 'gone']);
  const saved = [];
  const back = await deckFromPowerPoint(buf, { savePicture: async (name, data, mime) => { saved.push(mime); return `pic${saved.length}`; } });
  assert.equal(back.slides[0].bgImage, 'pic1');
  assert.deepEqual(saved, ['image/png']);
  assert.equal(back.slides[0].items[0].text, 'Welcome', 'the slide\'s boxes are still there');
  assert.equal(back.slides[1].bg, '#c4eed0');
  assert.equal(back.slides[1].bgImage, undefined);
  assert.equal(back.slides[2].bgImage, undefined, 'a picture that can\'t be read leaves the slide\'s colour');
});

test('PowerPoint: text in a shape goes out in the shape and comes back in it', async () => {
  const deck = { theme: 'light', slides: [{ id: 'a', items: [
    { id: 's1', type: 'shape', shape: 'round', fill: '#188038', text: 'Step 1\nPlan', size: 24, bold: true, x: 10, y: 20, w: 30, h: 20 },
    { id: 's2', type: 'shape', shape: 'ellipse', fill: 'accent', x: 50, y: 20, w: 20, h: 20 },
    { id: 's3', type: 'shape', shape: 'rect', fill: '#fde293', text: 'Note', color: '#202124', align: 'left', x: 10, y: 60, w: 30, h: 10 },
  ] }] };
  const back = await deckFromPowerPoint(await powerPointFromDeck(deck, {}), { savePicture: async () => 'x' });
  const items = back.slides[0].items;
  const round = items.find((i) => i.shape === 'round');
  assert.equal(round.type, 'shape');
  assert.equal(round.text, 'Step 1\nPlan');
  assert.equal(round.fill, '#188038');
  assert.equal(round.bold, true);
  assert.ok(Math.abs(round.size - 24) <= 1, String(round.size));
  assert.equal(round.align, undefined, 'centred, as shapes are');
  const plain = items.find((i) => i.shape === 'ellipse');
  assert.equal(plain.text, undefined);
  const note = items.find((i) => i.shape === 'rect');
  assert.deepEqual([note.text, note.color, note.align], ['Note', '#202124', 'left']);
  assert.equal(items.filter((i) => i.type === 'text').length, 0, 'no stray text boxes');
});

test('PowerPoint: triangles, diamonds, block arrows, chevrons, stars and callouts both ways', async () => {
  const kinds = ['triangle', 'diamond', 'arrowblock', 'chevron', 'star', 'callout'];
  const deck = { theme: 'light', slides: [{ id: 'a', items: kinds.map((shape, i) => ({ id: `s${i}`, type: 'shape', shape, fill: '#188038', x: 5 + i * 15, y: 20, w: 12, h: 20, ...(shape === 'callout' && { text: 'Hello!' }) })) }] };
  const buf = await powerPointFromDeck(deck, {});
  const JSZip = (await import('jszip')).default;
  const xml = await (await JSZip.loadAsync(buf)).file('ppt/slides/slide1.xml').async('string');
  for (const p of ['triangle', 'diamond', 'rightArrow', 'chevron', 'star5', 'wedgeRoundRectCallout']) assert.match(xml, new RegExp(`prst="${p}"`), p);
  const back = await deckFromPowerPoint(buf, { savePicture: async () => 'x' });
  assert.deepEqual(back.slides[0].items.map((i) => i.shape), kinds);
  assert.equal(back.slides[0].items.find((i) => i.shape === 'callout').text, 'Hello!');
});

test('PowerPoint: outlines on shapes and text boxes, and a text box\'s own colour, both ways', async () => {
  const deck = { theme: 'light', slides: [{ id: 'a', items: [
    { id: 'r', type: 'shape', shape: 'rect', fill: '#e8f0fe', outline: '#1a73e8', outlineW: 4, x: 5, y: 5, w: 30, h: 30 },
    { id: 'e', type: 'shape', shape: 'ellipse', fill: 'accent', text: 'Go', outline: 'text', outlineW: 2, x: 40, y: 5, w: 20, h: 30 },
    { id: 't', type: 'text', role: 'body', text: 'Boxed note', fill: '#fef7e0', outline: '#e37400', outlineW: 1, x: 5, y: 50, w: 40, h: 20, size: 24 },
    { id: 'p', type: 'text', role: 'body', text: 'Plain', x: 50, y: 50, w: 40, h: 20, size: 24 },
  ] }] };
  const back = (await deckFromPowerPoint(await powerPointFromDeck(deck, {}), { savePicture: async () => 'x' })).slides[0].items;
  const rect = back.find((i) => i.shape === 'rect');
  assert.deepEqual([rect.type, rect.outline, rect.outlineW], ['shape', '#1a73e8', 4]);
  const ell = back.find((i) => i.shape === 'ellipse');
  assert.deepEqual([ell.text, ell.outline, ell.outlineW], ['Go', '#202124', 2]);
  const boxed = back.find((i) => i.text === 'Boxed note');
  assert.deepEqual([boxed.type, boxed.fill, boxed.outline, boxed.outlineW], ['text', '#fef7e0', '#e37400', 1], 'a filled text box stays a text box');
  const plain = back.find((i) => i.text === 'Plain');
  assert.deepEqual([plain.type, plain.fill, plain.outline], ['text', undefined, undefined]);
});

test('Excel downloads of tables: values as they are (never formulas), dates and numbers typed, heading frozen', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const { excelFromTable } = await import('../src/office/excel.js');
  const buf = await excelFromTable('Responses: Q1/Q2', [['Name', 'Due', 'Count', 'Note'], ['=cmd()', '2026-11-09', '12', 'two\nlines'], ['+SUM(A1)', '', '0012345678901234567', '']]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  assert.equal(ws.name, 'Responses  Q1 Q2');
  assert.equal(ws.getCell('A2').value, '=cmd()', 'text, not a formula');
  assert.equal(ws.getCell('A2').formula, undefined);
  assert.equal(ws.getCell('A3').value, '+SUM(A1)');
  assert.ok(ws.getCell('B2').value instanceof Date);
  assert.equal(ws.getCell('C2').value, 12);
  assert.equal(ws.getCell('C3').value, '0012345678901234567', 'long digit strings stay text');
  assert.equal(ws.getCell('D2').alignment.wrapText, true);
  assert.equal(ws.getRow(1).font.bold, true);
  assert.equal(ws.views[0].state, 'frozen');
});

test('Excel: duplicates, unique values, top and bottom, averages and custom formula rules carry both ways', async () => {
  const rules = [
    { id: 'a', range: 'A2:A20', when: 'duplicate', fill: '#fce8e6' },
    { id: 'b', range: 'A2:A20', when: 'unique', fill: '#e6f4ea' },
    { id: 'c', range: 'B2:B20', when: 'top', value: '3', fill: '#e6f4ea' },
    { id: 'd', range: 'B2:B20', when: 'bottom', value: '2', fill: '#fce8e6' },
    { id: 'e', range: 'B2:B20', when: 'aboveAvg', fill: '#e8f0fe' },
    { id: 'f', range: 'B2:B20', when: 'belowAvg', fill: '#fef7e0' },
    { id: 'g', range: 'A2:C20', when: 'formula', value: '=AND($C2="done",TEXTAFTER($A2,"@")<>"")', fill: '#f1f3f4' },
  ];
  const back = await sheetFromExcel(await excelFromSheet({ sheets: [{ name: 'S', rules, cells: { A1: 'x' } }] }));
  assert.deepEqual(back.sheets[0].rules.map(({ id, ...r }) => r), rules.map(({ id, ...r }) => r));
  // How Excel itself writes them in the file.
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await excelFromSheet({ sheets: [{ name: 'S', rules, cells: { A1: 'x' } }] }));
  const xr = wb.worksheets[0].conditionalFormattings.flatMap((cf) => cf.rules);
  assert.equal(xr[0].formulae[0], 'AND(A2<>"",COUNTIF($A$2:$A$20,A2)>1)');
  assert.deepEqual([xr[2].type, xr[2].rank, xr[3].bottom, xr[5].aboveAverage], ['top10', 3, true, false]);
  assert.equal(xr[6].formulae[0], 'AND($C2="done",_xlfn.TEXTAFTER($A2,"@")<>"")', 'newer functions get Excel\'s prefix');
});

test('Excel: colour scales carry both ways', async () => {
  const rules = [{ id: 'a', range: 'B2:B20', when: 'scale', scale: ['#f8696b', '#ffeb84', '#63be7b'] }, { id: 'b', range: 'C2:C20', when: 'scale', scale: ['#ffffff', '#5a8ac6'] }];
  const buf = await excelFromSheet({ sheets: [{ name: 'S', rules, cells: { A1: 'x' } }] });
  const back = await sheetFromExcel(buf);
  assert.deepEqual(back.sheets[0].rules.map(({ id, ...r }) => r), rules.map(({ id, ...r }) => r));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const xr = wb.worksheets[0].conditionalFormattings.flatMap((cf) => cf.rules);
  assert.deepEqual([xr[0].type, xr[0].cfvo.map((c) => c.type), xr[1].color.map((c) => c.argb)], ['colorScale', ['min', 'percentile', 'max'], ['FFFFFFFF', 'FF5A8AC6']]);
});

test('Excel: date rules carry both ways', async () => {
  const rules = [
    { id: 'a', range: 'D2:D50', when: 'dateToday', fill: '#e8f0fe' },
    { id: 'b', range: 'D2:D50', when: 'datePast', fill: '#fce8e6' },
    { id: 'c', range: 'D2:D50', when: 'dateNext7', fill: '#fef7e0' },
    { id: 'd', range: 'D2:D50', when: 'datePast7', fill: '#f1f3f4' },
    { id: 'e', range: 'D2:D50', when: 'dateThisMonth', fill: '#f3e8fd' },
    { id: 'f', range: 'E2:E50', when: 'dateBefore', value: '2026-12-01', fill: '#e6f4ea' },
    { id: 'g', range: 'E2:E50', when: 'dateAfter', value: 'today', fill: '#e6f4ea' },
  ];
  const buf = await excelFromSheet({ sheets: [{ name: 'S', rules, cells: { A1: 'x' } }] });
  const back = await sheetFromExcel(buf);
  assert.deepEqual(back.sheets[0].rules.map(({ id, ...r }) => r), rules.map(({ id, ...r }) => r));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const xr = wb.worksheets[0].conditionalFormattings.flatMap((cf) => cf.rules);
  assert.deepEqual([xr[0].type, xr[0].timePeriod, xr[5].formulae[0]], ['timePeriod', 'today', 'AND(ISNUMBER(E2),E2<DATE(2026,12,1))']);
});

test('Excel: data bars carry both ways', async () => {
  const rules = [{ id: 'a', range: 'B2:B20', when: 'bars', bar: '#63be7b' }];
  const buf = await excelFromSheet({ sheets: [{ name: 'S', rules, cells: { A1: 'x' } }] });
  assert.deepEqual((await sheetFromExcel(buf)).sheets[0].rules.map(({ id, ...r }) => r), [{ range: 'B2:B20', when: 'bars', bar: '#63be7b' }]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.equal(wb.worksheets[0].conditionalFormattings[0].rules[0].type, 'dataBar');
});

test('Excel: validation rules (numbers, dates, text length, email, web, custom formula) carry both ways', async () => {
  const validations = [
    { id: 'a', range: 'B2:B20', type: 'rule', check: { kind: 'whole', op: 'between', a: '1', b: '99' }, strict: true, message: 'A quantity from 1 to 99' },
    { id: 'b', range: 'C2:C20', type: 'rule', check: { kind: 'number', op: 'gte', a: '0' }, strict: false },
    { id: 'c', range: 'D2:D20', type: 'rule', check: { kind: 'date', op: 'gt', a: '2026-01-01' }, strict: true },
    { id: 'd', range: 'E2:E20', type: 'rule', check: { kind: 'length', op: 'lte', a: '10' }, strict: true },
    { id: 'e', range: 'F2:F20', type: 'rule', check: { kind: 'email' }, strict: true },
    { id: 'f', range: 'G2:G20', type: 'rule', check: { kind: 'url' }, strict: false },
    { id: 'g', range: 'H2:H20', type: 'rule', check: { kind: 'formula', a: '=H2<=$I$1' }, strict: false },
  ];
  const buf = await excelFromSheet({ sheets: [{ name: 'S', validations, cells: { A1: 'x' } }] });
  const back = (await sheetFromExcel(buf)).sheets[0].validations.map(({ id, ...v }) => v);
  assert.deepEqual(back, validations.map(({ id, ...v }) => v));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const m = wb.worksheets[0].dataValidations.model;
  assert.deepEqual([m.B2.type, m.B2.operator, m.B2.errorStyle, m.B2.error], ['whole', 'between', 'stop', 'A quantity from 1 to 99']);
  assert.deepEqual([m.D5.type, new Date(m.D5.formulae[0]).toISOString().slice(0, 10), m.C2.errorStyle], ['date', '2026-01-01', 'warning']);
});

test('PowerPoint: stacked, area, scatter and doughnut charts from spreadsheets', async () => {
  const { powerPointFromDeck, scatterSeries } = await import('../src/office/powerpoint.js');
  assert.deepEqual(scatterSeries({ categories: ['1', '2'], series: [{ name: 'H', values: [150, 160] }, { name: 'W', values: [50, null] }] }),
    [{ name: 'H', values: [150, 160] }, { name: 'W', values: [50, 0] }]);
  assert.deepEqual(scatterSeries({ categories: ['Ann', 'Bo'], series: [{ name: 'S', values: [5, 7] }] })[0].values, [1, 2]);
  const data = { categories: ['Q1', 'Q2'], series: [{ name: 'North', values: [3, 4] }, { name: 'South', values: [2, 5] }] };
  const items = ['stackedColumn', 'area', 'scatter', 'doughnut'].map((t, i) => ({ id: `c${i}`, type: 'chart', chartType: t, data, x: 0, y: 0, w: 80, h: 60 }));
  const buf = await powerPointFromDeck({ theme: 'light', slides: items.map((it, i) => ({ id: `s${i}`, items: [it] })) });
  const zip = await JSZip.loadAsync(buf);
  const charts = await Promise.all(Object.keys(zip.files).filter((f) => /ppt\/charts\/chart\d+\.xml$/.test(f)).sort().map((f) => zip.file(f).async('string')));
  const all = charts.join('\n');
  assert.match(all, /<c:grouping val="stacked"\/>/);
  assert.match(all, /<c:areaChart>/);
  assert.match(all, /<c:scatterChart>/);
  assert.match(all, /<c:doughnutChart>/);
});

test('Excel: charts go into the download as real Excel charts over the sheet\'s cells', async () => {
  const { chartLayout, chartXml } = await import('../src/office/xlsxcharts.js');
  const cells = { A1: 'Month', B1: 'North', C1: 'South', A2: 'Jan', B2: '10', C2: '4', A3: 'Feb', B3: '=B2+2', C3: '5', E1: 'H', F1: 'W', E2: '150', F2: '50', E3: '160', F3: '58' };
  const L = chartLayout('A1:C3', cells);
  assert.deepEqual([L.headRow, L.labelCol, L.series.map((s) => s.name)], [true, true, ['North', 'South']]);
  const bar = chartXml({ type: 'stackedBar', range: 'A1:C3', title: 'Sales & costs' }, 'Q1 data', cells);
  assert.match(bar, /<c:barDir val="bar"\/><c:grouping val="stacked"\/>/);
  assert.match(bar, /<c:f>'Q1 data'!\$B\$2:\$B\$3<\/c:f>/, 'series point at the cells');
  assert.match(bar, /<c:f>'Q1 data'!\$A\$2:\$A\$3<\/c:f>/, 'categories from the first column');
  assert.match(bar, /Sales &amp; costs/);
  assert.match(chartXml({ type: 'scatter', range: 'E1:F3' }, 'S', cells), /<c:xVal><c:numRef><c:f>'S'!\$E\$2:\$E\$3<\/c:f>/);
  assert.match(chartXml({ type: 'doughnut', range: 'A1:B3' }, 'S', cells), /<c:holeSize val="58"\/>/);
  assert.equal(chartXml({ type: 'line', range: 'A1:A3' }, 'S', cells), null, 'no numbers: no chart');
  // A whole workbook: the chart parts, the drawing, and a sheet that opens again (notes kept too).
  const buf = await excelFromSheet({ sheets: [{ name: 'Q1 data', cells, notes: { A1: 'Months' }, charts: { a: { type: 'column', range: 'A1:C3', title: 'By month', x: 300, y: 40, w: 400, h: 250 }, b: { type: 'pie', range: 'A1:B3' } } }, { name: 'Other', cells: { A1: 'x' } }] });
  const zip = await JSZip.loadAsync(buf);
  assert.deepEqual(Object.keys(zip.files).filter((f) => /^xl\/(charts|drawings)\/[^/]+\.xml$/.test(f)).sort(), ['xl/charts/chart1.xml', 'xl/charts/chart2.xml', 'xl/drawings/drawing1.xml']);
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.ok(sheet.indexOf('<drawing ') < sheet.indexOf('<legacyDrawing '), 'the drawing comes before the notes');
  assert.match(await zip.file('[Content_Types].xml').async('string'), /\/xl\/charts\/chart2\.xml/);
  assert.equal(await zip.file('xl/worksheets/sheet2.xml').async('string').then((x) => /<drawing /.test(x)), false);
  const back = await sheetFromExcel(buf);
  assert.equal(back.sheets[0].cells.A2, 'Jan');
  assert.equal(back.sheets[0].notes?.A1, 'Months');
});

test('Excel: charts in an uploaded file come in as Sheets charts', async () => {
  const { chartFromXml, chartKind, placeOf } = await import('../src/office/xlsxcharts.js');
  const cells = { A1: 'Month', B1: 'North', C1: 'South', A2: 'Jan', B2: '10', C2: '4', A3: 'Feb', B3: '12', C3: '5' };
  const charts = { a: { type: 'stackedBar', range: 'A1:C3', title: 'Sales', x: 300, y: 50, w: 400, h: 250 }, b: { type: 'doughnut', range: 'A1:B3', title: '', x: 60, y: 330, w: 300, h: 200 } };
  const back = await sheetFromExcel(await excelFromSheet({ sheets: [{ name: 'Q1 data', cells, charts }] }));
  assert.deepEqual(Object.values(back.sheets[0].charts), Object.values(charts), 'a download opens again with its charts as they were');
  // Kinds Excel has, and charts of another sheet's cells (left out).
  assert.equal(chartKind('<c:bar3DChart><c:barDir val="col"/><c:grouping val="percentStacked"/></c:bar3DChart>'), 'stackedColumn');
  assert.equal(chartKind('<c:pie3DChart></c:pie3DChart>'), 'pie');
  assert.equal(chartKind('<c:radarChart></c:radarChart>'), null);
  const xml = (f) => `<c:chartSpace><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Costs &amp; more</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:lineChart><c:ser><c:cat><c:strRef><c:f>${f}!$A$2:$A$9</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${f}!$D$2:$D$9</c:f></c:numRef></c:val></c:ser></c:lineChart></c:plotArea></c:chart></c:chartSpace>`;
  assert.deepEqual(chartFromXml(xml('Data'), 'Data'), { type: 'line', title: 'Costs & more', range: 'A2:D9' });
  assert.equal(chartFromXml(xml("'Other sheet'"), 'Data'), null);
  // Anchored to cells: placed over the same cells on Sheets' grid.
  assert.deepEqual(placeOf({ from: { col: 2, colOff: 0, row: 3, rowOff: 9525 * 4 }, to: { col: 6, colOff: 0, row: 13, rowOff: 0 } }, { A: 50 }, { 2: 40 }),
    { x: 46 + 50 + 100, y: 24 + (24 + 40 + 24) + 4, w: 400, h: 236 }, 'column A is 50 wide, row 2 is 40 high; the rest are the standard 100 and 24');
});

test('PowerPoint: charts in an uploaded presentation come in with their figures', async () => {
  const { powerPointFromDeck, deckFromPowerPoint } = await import('../src/office/powerpoint.js');
  const { chartDataFromXml } = await import('../src/office/xlsxcharts.js');
  const data = { categories: ['Q1', 'Q2', 'Q3'], series: [{ name: 'North', values: [3, 4, null] }, { name: 'South', values: [2, 5, 6] }] };
  const deck = { theme: 'light', slides: [{ id: 's1', items: [
    { id: 'c', type: 'chart', x: 10, y: 20, w: 60, h: 50, title: 'Sales by quarter', chartType: 'stackedColumn', data },
    { id: 'd', type: 'chart', x: 0, y: 0, w: 30, h: 30, chartType: 'doughnut', data: { categories: ['A', 'B'], series: [{ name: 'Share', values: [1, 3] }] } },
  ] }] };
  const back = await deckFromPowerPoint(await powerPointFromDeck(deck), { savePicture: async () => null });
  const charts = back.slides[0].items.filter((i) => i.type === 'chart');
  assert.equal(charts.length, 2);
  assert.deepEqual([charts[0].chartType, charts[0].title, charts[1].chartType], ['stackedColumn', 'Sales by quarter', 'doughnut']);
  assert.deepEqual(charts[0].data.categories, ['Q1', 'Q2', 'Q3']);
  assert.deepEqual(charts[0].data.series.map((s) => s.name), ['North', 'South']);
  assert.deepEqual(charts[0].data.series[1].values, [2, 5, 6]);
  assert.ok(Math.abs(charts[0].x - 10) < 0.5 && Math.abs(charts[0].w - 60) < 0.5, 'where it was');
  assert.equal(charts[0].fileId, undefined, 'not tied to a spreadsheet');
  // Scatter: X values as the names.
  const sc = chartDataFromXml('<c:scatterChart><c:ser><c:tx><c:v>W</c:v></c:tx><c:xVal><c:numRef><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>150</c:v></c:pt><c:pt idx="1"><c:v>160</c:v></c:pt></c:numCache></c:numRef></c:xVal><c:yVal><c:numRef><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>50</c:v></c:pt><c:pt idx="1"><c:v>58</c:v></c:pt></c:numCache></c:numRef></c:yVal></c:ser></c:scatterChart>');
  assert.deepEqual(sc, { type: 'scatter', data: { categories: ['150', '160'], series: [{ name: 'W', values: [50, 58] }] } });
});

test('Word: paragraph alignment, text colours and highlights are read', async () => {
  const file = new Document({ sections: [{ children: [
    new Paragraph({ text: 'A centred title', heading: HeadingLevel.HEADING_2, alignment: AlignmentType.CENTER }),
    new Paragraph({ text: 'Right aligned', alignment: AlignmentType.RIGHT }),
    new Paragraph({ text: 'Justified text', alignment: AlignmentType.JUSTIFIED }),
    new Paragraph({ children: [new TextRun('Plain, '), new TextRun({ text: 'red bold', color: 'C5221F', bold: true }), new TextRun(', '), new TextRun({ text: 'marked', highlight: 'yellow' }), new TextRun(' and '), new TextRun({ text: 'both', color: '1A73E8', shading: { type: 'clear', color: 'auto', fill: 'FCE8E6' } })] }),
    new Paragraph({ children: [new TextRun({ text: 'Black is the default', color: '000000' })] }),
  ] }] });
  const { doc } = await docFromWord(await Packer.toBuffer(file));
  const align = (n) => n.attrs?.textAlign;
  assert.deepEqual([align(doc.content[0]), doc.content[0].type, align(doc.content[1]), align(doc.content[2])], ['center', 'heading', 'right', 'justify']);
  assert.equal(text(doc.content[0]), 'A centred title', 'no marker left in the text');
  const runs = doc.content[3].content;
  assert.equal(text(doc.content[3]), 'Plain, red bold, marked and both');
  const style = (t) => runs.find((r) => r.text === t)?.marks?.find((m) => m.type === 'textStyle')?.attrs;
  assert.equal(style('red bold').color, '#c5221f');
  assert.ok(runs.find((r) => r.text === 'red bold').marks.some((m) => m.type === 'bold'), 'bold kept');
  assert.equal(style('marked').backgroundColor, '#ffff00');
  assert.deepEqual([style('both').color, style('both').backgroundColor], ['#1a73e8', '#fce8e6']);
  assert.equal(style('Plain, '), undefined);
  assert.equal(doc.content[4].content[0].marks, undefined, 'black needs no colour');
  // A Docs download opens again with its alignment and colours.
  const back = (await docFromWord(await wordFromDoc(doc, 'Colours'))).doc;
  assert.equal(back.content[1].attrs.textAlign, 'right');
  assert.equal(back.content[3].content.find((r) => r.text === 'red bold').marks.find((m) => m.type === 'textStyle').attrs.color, '#c5221f');
});

test('Word: the page setup (paper, orientation, margins, header, footer, page numbers) is read', async () => {
  const { pageOfWord } = await import('../src/office/word.js');
  const setup = { size: 'letter', orientation: 'landscape', margin: 'narrow', header: 'Acme — Confidential', footer: 'Board pack', numbers: true, watermark: '' };
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] };
  const page = await pageOfWord(await wordFromDoc(doc, 'Pack', { page: setup }));
  assert.deepEqual(page, { orientation: 'landscape', size: 'letter', margin: 'narrow', header: 'Acme — Confidential', footer: 'Board pack', numbers: true });
  const a5 = await pageOfWord(await wordFromDoc(doc, 'Note', { page: { ...setup, size: 'a5', orientation: 'portrait', margin: 'wide', header: '', footer: '', numbers: true } }));
  assert.deepEqual([a5.size, a5.orientation, a5.margin, a5.footer, a5.numbers], ['a5', 'portrait', 'wide', '', true]);
  // A plain document: A4 portrait with normal margins (Word's own default), no header or footer.
  const plain = await pageOfWord(await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('x')] }] })));
  assert.deepEqual([plain.size, plain.orientation, plain.margin, plain.header, plain.footer], ['a4', 'portrait', 'normal', undefined, undefined]);
  assert.deepEqual(await pageOfWord(Buffer.from('not a zip')), {});
});

test('Excel: links in cells come in as HYPERLINK formulas', async () => {
  const { linkCell } = await import('../src/office/excel.js');
  assert.equal(linkCell({ text: 'Say "hi"', hyperlink: 'https://example.com/orders?a=1&b=2' }), '=HYPERLINK("https://example.com/orders?a=1&b=2", "Say ""hi""")');
  assert.equal(linkCell({ text: 'https://acme.com', hyperlink: 'https://acme.com' }), '=HYPERLINK("https://acme.com")');
  assert.equal(linkCell({ text: 'Mail us', hyperlink: 'mailto:hi@acme.com' }), '=HYPERLINK("mailto:hi@acme.com", "Mail us")');
  assert.equal(linkCell({ text: 'Totals', hyperlink: "#'Sheet 2'!A1" }), 'Totals', 'a place in the workbook keeps its text');
  assert.equal(linkCell({ text: 'Run me', hyperlink: 'javascript:alert(1)' }), 'Run me');
  assert.equal(linkCell({ text: { richText: [{ text: 'Rich ' }, { text: 'link' }] }, hyperlink: 'https://x.org' }), '=HYPERLINK("https://x.org", "Rich link")');
  // A real workbook: the link opens again as a link, and goes back out as one.
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Links');
  ws.getCell('A1').value = { text: 'Our site', hyperlink: 'https://acme.com/' };
  ws.getCell('A2').value = 'plain';
  const back = await sheetFromExcel(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.equal(back.sheets[0].cells.A1, '=HYPERLINK("https://acme.com/", "Our site")');
  assert.equal(back.sheets[0].cells.A2, 'plain');
  const out = new ExcelJS.Workbook();
  await out.xlsx.load(await excelFromSheet(back));
  assert.equal(out.worksheets[0].getCell('A1').value.formula, 'HYPERLINK("https://acme.com/", "Our site")');
});

test('Word: comments come in on the words they were about', async () => {
  const { CommentRangeStart, CommentRangeEnd, CommentReference } = await import('docx');
  const file = new Document({
    comments: { children: [
      { id: 0, author: 'Jane Smith', date: new Date('2026-10-01T10:00:00Z'), children: [new Paragraph('Can we check this figure?')] },
      { id: 1, author: 'Raj Patel', date: new Date('2026-10-02T09:30:00Z'), children: [new Paragraph('Agreed.'), new Paragraph('Second line.')] },
    ] },
    sections: [{ children: [
      new Paragraph({ children: [new TextRun('Revenue grew by '), new CommentRangeStart(0), new TextRun({ text: '12 percent', bold: true }), new CommentRangeEnd(0), new TextRun({ children: [new CommentReference(0)] }), new TextRun(' this year.')] }),
      new Paragraph({ children: [new CommentRangeStart(1), new TextRun('Costs were flat.'), new CommentRangeEnd(1), new TextRun({ children: [new CommentReference(1)] })] }),
    ] }],
  });
  const { doc, comments } = await docFromWord(await Packer.toBuffer(file));
  assert.equal(text(doc.content[0]), 'Revenue grew by 12 percent this year.');
  assert.equal(comments.length, 2);
  assert.deepEqual(comments.map((c) => [c.author, c.text, c.quote]), [['Jane Smith', 'Can we check this figure?', '12 percent'], ['Raj Patel', 'Agreed.\nSecond line.', 'Costs were flat.']]);
  assert.equal(comments[0].at, Date.parse('2026-10-01T10:00:00Z'));
  const marked = doc.content[0].content.find((n) => n.text === '12 percent');
  assert.deepEqual(marked.marks.map((m) => m.type).sort(), ['bold', 'comment']);
  assert.equal(marked.marks.find((m) => m.type === 'comment').attrs.id, comments[0].id);
  // No comments: none, and nothing marked.
  const plain = await docFromWord(await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('x')] }] })));
  assert.deepEqual(plain.comments, []);
});

test('Word: open comment threads go into the download as Word comments', async () => {
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Revenue grew by ' }, { type: 'text', text: '12', marks: [{ type: 'comment', attrs: { id: 't1' } }] }, { type: 'text', text: ' percent', marks: [{ type: 'bold' }, { type: 'comment', attrs: { id: 't1' } }] }, { type: 'text', text: ' this year.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Costs were flat.', marks: [{ type: 'comment', attrs: { id: 't2' } }] }] },
  ] };
  const comments = [
    { id: 't1', author: 'Olivia Owner', at: Date.parse('2026-11-01T09:00:00Z'), text: 'Check this figure', replies: [{ author: 'Kim Park', text: 'Checked: it is right' }] },
    { id: 't2', author: 'Kim Park', at: null, text: 'Fine', replies: [] },
    { id: 'gone', author: 'X', text: 'On words no longer there', replies: [] },
  ];
  const buf = await wordFromDoc(doc, 'Report', { comments });
  const back = await docFromWord(buf);
  assert.deepEqual(back.comments.map((c) => [c.author, c.text, c.quote, c.replies.map((r) => [r.author, r.text])]), [
    ['Olivia Owner', 'Check this figure', '12 percent', [['Kim Park', 'Checked: it is right']]],
    ['Kim Park', 'Fine', 'Costs were flat.', []],
  ], 'the reply is a Word reply, and comes back as one');
  // A resolved thread is marked done in Word, and comes back resolved.
  const done = await docFromWord(await wordFromDoc(doc, 'Report', { comments: [{ ...comments[0], resolved: true }] }));
  assert.equal(done.comments[0].resolved, true);
  assert.equal(back.comments[0].at, Date.parse('2026-11-01T09:00:00Z'));
  assert.equal(text(back.doc.content[0]), 'Revenue grew by 12 percent this year.', 'the text is as it was');
  // Without threads, no comments part at all.
  const zip = await (await import('jszip')).default.loadAsync(await wordFromDoc(doc, 'Report'));
  assert.equal(zip.file('word/comments.xml'), null);
});

/** A PowerPoint file with comments added to its slides (the kinds PowerPoint writes). */
async function withPptComments(buf, { legacy, modern }) {
  const zip = await JSZip.loadAsync(buf);
  const types = await zip.file('[Content_Types].xml').async('string');
  let extra = '';
  if (legacy) {
    zip.file('ppt/commentAuthors.xml', '<?xml version="1.0"?><p:cmAuthorLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cmAuthor id="0" name="Jane Smith" initials="JS" lastIdx="2" clrIdx="0"/><p:cmAuthor id="1" name="Raj &amp; Co" initials="RC" lastIdx="1" clrIdx="1"/></p:cmAuthorLst>');
    zip.file('ppt/comments/comment1.xml', `<?xml version="1.0"?><p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:p15="http://schemas.microsoft.com/office/powerpoint/2012/main">
      <p:cm authorId="0" dt="2026-10-01T10:00:00.000" idx="1"><p:pos x="10" y="10"/><p:text>Make the title shorter</p:text></p:cm>
      <p:cm authorId="1" dt="2026-10-02T10:00:00.000" idx="1"><p:pos x="10" y="10"/><p:text>Done</p:text><p:extLst><p:ext uri="{C676402C-5697-4E1C-873F-D02D1690AC5C}"><p15:threadingInfo timeZoneBias="0"><p15:parentCm authorId="0" idx="1"/></p15:threadingInfo></p:ext></p:extLst></p:cm>
    </p:cmLst>`);
    const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels').async('string');
    zip.file('ppt/slides/_rels/slide1.xml.rels', rels.replace('</Relationships>', '<Relationship Id="rIdCm1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments/comment1.xml"/></Relationships>'));
    extra += '<Override PartName="/ppt/comments/comment1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.comments+xml"/>';
  }
  if (modern) {
    zip.file('ppt/authors.xml', '<?xml version="1.0"?><p188:authorLst xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main"><p188:author id="{A1}" name="Kim Park" initials="KP" userId="kim" providerId="None"/><p188:author id="{B2}" name="Lee Wu" initials="LW" userId="lee" providerId="None"/></p188:authorLst>');
    zip.file('ppt/comments/modernComment_101_1.xml', `<?xml version="1.0"?><p188:cmLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main">
      <p188:cm id="{C1}" authorId="{A1}" created="2026-10-05T09:00:00.000" status="resolved"><pc:sldMkLst xmlns:pc="http://schemas.microsoft.com/office/powerpoint/2013/main/command"/><p188:replyLst><p188:reply id="{R1}" authorId="{B2}" created="2026-10-05T10:00:00.000"><p188:txBody><a:bodyPr/><a:p><a:r><a:t>Agreed</a:t></a:r></a:p></p188:txBody></p188:reply></p188:replyLst><p188:txBody><a:bodyPr/><a:p><a:r><a:t>Swap these two charts</a:t></a:r></a:p><a:p><a:r><a:t>and add a source</a:t></a:r></a:p></p188:txBody></p188:cm>
    </p188:cmLst>`);
    const f = 'ppt/slides/_rels/slide2.xml.rels';
    zip.file(f, (await zip.file(f).async('string')).replace('</Relationships>', '<Relationship Id="rIdMc1" Type="http://schemas.microsoft.com/office/2018/10/relationships/comments" Target="../comments/modernComment_101_1.xml"/></Relationships>'));
  }
  zip.file('[Content_Types].xml', types.replace('</Types>', `${extra}</Types>`));
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('PowerPoint: comments on slides come in, older and newer kinds, with replies', async () => {
  const { powerPointFromDeck, deckFromPowerPoint, commentsOfDeck } = await import('../src/office/powerpoint.js');
  const plain = await powerPointFromDeck({ theme: 'light', slides: [{ id: 'a', items: [{ id: 't', type: 'text', x: 5, y: 5, w: 50, h: 10, text: 'Plan' }] }, { id: 'b', items: [] }] });
  const deck = await deckFromPowerPoint(await withPptComments(plain, { legacy: true, modern: true }), { savePicture: async () => null });
  const cs = commentsOfDeck(deck);
  assert.deepEqual(cs.map((c) => [deck.slides.findIndex((s) => s.id === c.slideId), c.author, c.text, c.resolved, c.replies.map((r) => [r.author, r.text])]), [
    [0, 'Jane Smith', 'Make the title shorter', false, [['Raj & Co', 'Done']]],
    [1, 'Kim Park', 'Swap these two charts\nand add a source', true, [['Lee Wu', 'Agreed']]],
  ]);
  assert.equal(cs[1].at, Date.parse('2026-10-05T09:00:00.000'));
  assert.equal(JSON.stringify(deck).includes('Swap these'), false, 'comments aren\'t part of the presentation itself');
  assert.deepEqual(commentsOfDeck(await deckFromPowerPoint(plain, { savePicture: async () => null })), []);
});

test('PowerPoint: open comment threads go into the download on their slides', async () => {
  const { powerPointFromDeck, deckFromPowerPoint, commentsOfDeck } = await import('../src/office/powerpoint.js');
  const deck = { theme: 'light', slides: [{ id: 's1', items: [] }, { id: 's2', items: [] }] };
  const comments = [
    { slideId: 's2', author: 'Olivia Owner', at: Date.parse('2026-11-01T09:00:00Z'), text: 'Add the <source> & date', replies: [{ author: 'Kim Park', at: Date.parse('2026-11-01T10:00:00Z'), text: 'Added' }] },
    { slideId: 's1', author: 'Kim Park', at: null, text: 'Nice title', replies: [] },
    { slideId: 'gone', author: 'X', text: 'On a deleted slide', replies: [] },
  ];
  const buf = await powerPointFromDeck(deck, { comments });
  const back = await deckFromPowerPoint(buf, { savePicture: async () => null });
  const got = commentsOfDeck(back).map((c) => [back.slides.findIndex((s) => s.id === c.slideId), c.author, c.text, c.replies.map((r) => [r.author, r.text])]);
  assert.deepEqual(got, [[0, 'Kim Park', 'Nice title', []], [1, 'Olivia Owner', 'Add the <source> & date', [['Kim Park', 'Added']]]]);
  assert.equal(commentsOfDeck(back)[1].at, Date.parse('2026-11-01T09:00:00Z'));
  const zip = await JSZip.loadAsync(await powerPointFromDeck(deck));
  assert.equal(zip.file('ppt/commentAuthors.xml'), null, 'none: no comment parts');
});

test('Excel: tables come in as alternating colours', async () => {
  const { bandFromTable } = await import('../src/office/excel.js');
  assert.deepEqual(bandFromTable({ tableRef: 'b2:d10', style: { theme: 'TableStyleMedium7', showRowStripes: true }, headerRow: true, totalsRow: true }, 3),
    { id: 't3', range: 'B2:D10', header: true, footer: true, head: '#34a853', odd: '#ffffff', even: '#e6f4ea', foot: '#bfe3c8' });
  assert.equal(bandFromTable({ tableRef: 'A1:B4', style: { theme: 'TableStyleLight9' } }).head, '#4a86e8', 'Light9 is the blue one');
  assert.equal(bandFromTable({ tableRef: 'A1:B4', style: { theme: 'TableStyleMedium2', showRowStripes: false } }).even, '#ffffff', 'no stripes: one colour');
  assert.equal(bandFromTable({ tableRef: 'nope' }), null);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sales');
  ws.addTable({ name: 'Sales', ref: 'B2', headerRow: true, totalsRow: true, style: { theme: 'TableStyleMedium3', showRowStripes: true },
    columns: [{ name: 'Region', totalsRowLabel: 'Total' }, { name: 'Amount', totalsRowFunction: 'sum' }], rows: [['North', 10], ['South', 20]] });
  const back = await sheetFromExcel(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.deepEqual(back.sheets[0].bands, [{ id: 't1', range: 'B2:C5', header: true, footer: true, head: '#f6911e', odd: '#ffffff', even: '#feefe3', foot: '#fcd5b2' }]);
  assert.equal(back.sheets[0].cells.B3, 'North');
});

test('Excel: a table\'s structured references become ranges, so its total row works', async () => {
  const { plainTableRefs, tableShape } = await import('../src/office/excel.js');
  const t = [tableShape({ name: 'Sales', tableRef: 'A1:C6', headerRow: true, totalsRow: true, columns: [{ name: 'Region' }, { name: 'Unit price' }, { name: 'Amount' }] })];
  const cases = [
    ['SUBTOTAL(109,Sales[Amount])', 6, 2, 'SUBTOTAL(109,C2:C5)'],
    ['SUM(sales[[#Totals],[Amount]])', 8, 4, 'SUM(C6)'],
    ['[@Amount]*2', 3, 2, 'C3*2'],
    ['Sales[@[Unit price]]*[@Amount]', 4, 2, 'B4*C4'],
    ['[@[Unit price]]+[Amount]', 4, 1, 'B4+C2:C5'],
    ['SUM(Sales[[Unit price]:[Amount]])', 9, 0, 'SUM(B2:C5)'],
    ['COUNTA(Sales[#All])', 9, 0, 'COUNTA(A1:C6)'],
    ['"Sales[Amount]"&Sales[#Headers]', 9, 0, '"Sales[Amount]"&A1:C1'],
    ['Other[x]+[@Amount]', 9, 5, 'Other[x]+[@Amount]'],
  ];
  for (const [f, r, c, want] of cases) assert.equal(plainTableRefs(f, t, r, c), want, f);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.addTable({ name: 'Sales', ref: 'A1', headerRow: true, totalsRow: true, style: { theme: 'TableStyleMedium2' },
    columns: [{ name: 'Region', totalsRowLabel: 'Total' }, { name: 'Amount', totalsRowFunction: 'sum' }], rows: [['North', 10], ['South', 20]] });
  const back = await sheetFromExcel(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.equal(back.sheets[0].cells.B4, '=SUBTOTAL(109,B2:B3)');
});

test('Excel: alternating colours go out as Excel tables when they can, and come back', async () => {
  const { tableOfBand } = await import('../src/office/excel.js');
  const cells = { A1: 'Region', B1: 'Amount', A2: 'North', B2: '10', A3: 'South', B3: '20', A4: 'Total', B4: '=SUM(B2:B3)', D1: 'x', E1: 'x', D2: '1' };
  const green = { id: 'g', range: 'A1:B4', header: true, footer: true, head: '#34a853', odd: '#ffffff', even: '#e6f4ea', foot: '#bfe3c8' };
  assert.deepEqual(tableOfBand(green, { cells }), { name: 'Table1', ref: 'A1:B4', columns: ['Region', 'Amount'], style: 'TableStyleMedium7', totals: true, stripes: true });
  assert.equal(tableOfBand({ ...green, range: 'D1:E2' }, { cells }), null, 'two columns with the same heading');
  assert.equal(tableOfBand({ ...green, head: '#123456' }, { cells }), null, 'colours of its own: painted instead');
  assert.equal(tableOfBand({ ...green, header: false }, { cells }), null);
  assert.equal(tableOfBand(green, { cells, merges: ['A2:B2'] }), null);
  // Out and back: the table, its style and its stripes; the cells keep their values.
  const sheet = { name: 'Sales', cells, bands: [green, { id: 'p', range: 'D1:E2', header: true, head: '#4a86e8', odd: '#ffffff', even: '#e8f0fe' }] };
  const buf = await excelFromSheet({ sheets: [sheet] });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const t = Object.values(wb.worksheets[0].tables)[0];
  assert.deepEqual([t.table.tableRef || t.table.ref, t.table.style.theme, t.table.totalsRow], ['A1:B4', 'TableStyleMedium7', true]);
  assert.equal(wb.worksheets[0].getCell('D1').fill?.fgColor?.argb, 'FF4A86E8', 'the band that can\'t be a table is painted as before');
  assert.equal(wb.worksheets[0].getCell('A3').fill?.fgColor?.argb, 'FFE6F4EA', 'painted too, for programs that don\'t draw table styles');
  const back = await sheetFromExcel(buf);
  assert.deepEqual(back.sheets[0].bands.map(({ id, ...b }) => b), [{ range: 'A1:B4', header: true, footer: true, head: '#34a853', odd: '#ffffff', even: '#e6f4ea', foot: '#bfe3c8' }]);
  assert.equal(back.sheets[0].cells.B4, '=SUM(B2:B3)');
  assert.equal(back.sheets[0].formats?.A3, undefined, 'the stripes come back as the band, not as cell colours');
});

/** A workbook with Microsoft 365 threaded comments on Sheet1 (and the old-style notes Excel writes beside them). */
async function withThreadedComments(buf) {
  const zip = await JSZip.loadAsync(buf);
  zip.file('xl/persons/person.xml', '<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><person displayName="Jane Smith" id="{P1}" userId="jane" providerId="None"/><person displayName="Raj &amp; Co" id="{P2}" userId="raj" providerId="None"/></personList>');
  zip.file('xl/threadedComments/threadedComment1.xml', `<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">
    <threadedComment ref="B2" dT="2026-10-01T10:00:00.00" personId="{P1}" id="{C1}"><text>Is this the final price?</text></threadedComment>
    <threadedComment ref="B2" dT="2026-10-01T11:00:00.00" personId="{P2}" id="{C2}" parentId="{C1}"><text>Yes, agreed &lt;today&gt;</text></threadedComment>
    <threadedComment ref="A3" dT="2026-10-02T09:00:00.00" personId="{P2}" id="{C3}" done="1"><text>Typo fixed</text></threadedComment>
  </ThreadedComments>`);
  const rels = 'xl/worksheets/_rels/sheet1.xml.rels';
  const old = zip.file(rels) ? await zip.file(rels).async('string') : '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  zip.file(rels, old.replace('</Relationships>', '<Relationship Id="rIdTc" Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="../threadedComments/threadedComment1.xml"/></Relationships>'));
  const wbRels = 'xl/_rels/workbook.xml.rels';
  zip.file(wbRels, (await zip.file(wbRels).async('string')).replace('</Relationships>', '<Relationship Id="rIdPeople" Type="http://schemas.microsoft.com/office/2017/10/relationships/person" Target="persons/person.xml"/></Relationships>'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('Excel: Microsoft 365 comment threads come in as Sheets comment threads, not as notes', async () => {
  const { commentsOfBook } = await import('../src/office/excel.js');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Prices');
  ws.getCell('A2').value = 'Pens'; ws.getCell('B2').value = 4; ws.getCell('A3').value = 'Pads';
  // Excel's copy for older versions, and a real note elsewhere.
  ws.getCell('B2').note = '[Threaded comment]\n\nYour version of Excel allows you to read this threaded comment; however, any edits to it will get removed if the file is opened in a newer version of Excel.\n\nComment:\n    Is this the final price?';
  ws.getCell('A2').note = 'Our usual supplier';
  const book = await sheetFromExcel(await withThreadedComments(Buffer.from(await wb.xlsx.writeBuffer())));
  assert.deepEqual(book.sheets[0].notes, { A2: 'Our usual supplier' }, 'the old-style copy is left out; real notes stay');
  assert.deepEqual(commentsOfBook(book).map((c) => [c.sheet, c.cell, c.author, c.text, c.resolved, c.replies.map((r) => [r.author, r.text])]), [
    [0, 'B2', 'Jane Smith', 'Is this the final price?', false, [['Raj & Co', 'Yes, agreed <today>']]],
    [0, 'A3', 'Raj & Co', 'Typo fixed', true, []],
  ]);
  assert.equal(JSON.stringify(book).includes('final price'), false, 'not part of the spreadsheet itself');
});

test('Excel: comment threads go into the download, and come back as threads', async () => {
  const { commentsOfBook } = await import('../src/office/excel.js');
  const data = { sheets: [{ name: 'Prices', cells: { A1: 'Item', B2: '4' }, notes: { A1: 'Kept as a note' } }, { name: 'Other', cells: { C3: 'x' } }] };
  const comments = [
    { sheet: 0, cell: 'B2', author: 'Olivia Owner', at: Date.parse('2026-11-01T09:00:00Z'), text: 'Is this right? <check>', replies: [{ author: 'Kim Park', at: Date.parse('2026-11-01T10:00:00Z'), text: 'Yes' }] },
    { sheet: 1, cell: 'C3', author: 'Kim Park', at: null, text: 'Other sheet', replies: [] },
  ];
  const buf = await excelFromSheet(data, { comments });
  const zip = await JSZip.loadAsync(buf);
  assert.match(await zip.file('xl/threadedComments/threadedComment1.xml').async('string'), /Is this right\? &lt;check&gt;/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.match(wb.worksheets[0].getCell('B2').note?.texts?.map((t) => t.text).join('') || String(wb.worksheets[0].getCell('B2').note), /^\[Threaded comment\][\s\S]*Comment:\n {4}Is this right\? <check>\nReply \(Kim Park\):\n {4}Yes$/, 'the copy older versions show');
  const back = await sheetFromExcel(buf);
  assert.deepEqual(back.sheets[0].notes, { A1: 'Kept as a note' });
  assert.deepEqual(commentsOfBook(back).map((c) => [c.sheet, c.cell, c.author, c.text, c.replies.map((r) => [r.author, r.text])]),
    [[0, 'B2', 'Olivia Owner', 'Is this right? <check>', [['Kim Park', 'Yes']]], [1, 'C3', 'Kim Park', 'Other sheet', []]]);
  assert.equal(commentsOfBook(back)[0].at, Date.parse('2026-11-01T09:00:00Z'));
  assert.equal((await JSZip.loadAsync(await excelFromSheet(data))).file('xl/persons/person.xml'), null, 'none: no comment parts');
});

test('Excel: an old-style copy of a comment thread, on its own, comes in as the thread', async () => {
  const { threadFromNote } = await import('../src/office/excel.js');
  const head = '[Threaded comment]\n\nYour version of Excel allows you to read this threaded comment; however, any edits to it will get removed if the file is opened in a newer version of Excel. Learn more: https://go.microsoft.com/fwlink/?linkid=870924\n\nComment:\n';
  assert.deepEqual(threadFromNote(`${head}    Is this right?\n    Two lines\nReply:\n    Yes\nReply (Kim Park):\n    Checked`), { author: '', text: 'Is this right?\nTwo lines', at: null, resolved: false, replies: [{ author: '', text: 'Yes', at: null }, { author: 'Kim Park', text: 'Checked', at: null }] });
  assert.equal(threadFromNote('Just a note'), null);
});

test('Word: suggestions go out as tracked changes, and tracked changes come in as suggestions', async () => {
  const at = Date.parse('2026-11-02T08:30:00Z');
  const sugg = (type, id, name) => ({ type, attrs: { id, by: 'u1', name, at } });
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'The meeting is in ' },
    { type: 'text', text: 'March', marks: [sugg('suggestDelete', 's1', 'Kim Park')] },
    { type: 'text', text: 'April', marks: [{ type: 'bold' }, sugg('suggestInsert', 's1', 'Kim Park')] },
    { type: 'text', text: ' at the office.' },
  ] }] };
  const buf = await wordFromDoc(doc, 'Plan');
  const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
  assert.match(xml, /<w:del w:id="\d+" w:author="Kim Park" w:date="2026-11-02T08:30:00Z">[\s\S]*<w:delText[^>]*>March<\/w:delText>/);
  assert.match(xml, /<w:ins w:id="\d+" w:author="Kim Park" w:date="2026-11-02T08:30:00Z">[\s\S]*<w:b\/>[\s\S]*April/);
  const { doc: back } = await docFromWord(buf);
  const p = back.content[0].content;
  assert.equal(text(back.content[0]), 'The meeting is in MarchApril at the office.');
  const marksOf = (t) => p.find((n) => n.text === t).marks.map((m) => [m.type, m.attrs?.name, m.attrs?.at]).filter(([k]) => k.startsWith('suggest'));
  assert.deepEqual(marksOf('March'), [['suggestDelete', 'Kim Park', at]]);
  assert.deepEqual(marksOf('April'), [['suggestInsert', 'Kim Park', at]]);
  assert.ok(p.find((n) => n.text === 'April').marks.some((m) => m.type === 'bold'), 'formatting kept');
  const idOf = (t, type) => p.find((n) => n.text === t).marks.find((m) => m.type === type).attrs.id;
  assert.equal(idOf('April', 'suggestInsert'), idOf('March', 'suggestDelete'), 'a deletion then an insertion is one replacement');
});

test('PowerPoint: animations go out as PowerPoint entrance effects and come back', async () => {
  const { powerPointFromDeck, deckFromPowerPoint, animationsOf } = await import('../src/office/powerpoint.js');
  const deck = { theme: 'light', numbers: true, slides: [{ id: 's1', transition: 'fade', items: [
    { id: 't', type: 'text', x: 5, y: 5, w: 60, h: 10, text: 'Title' },
    { id: 'a', type: 'text', x: 5, y: 20, w: 60, h: 10, text: 'First point', anim: 'fly', animAt: 2 },
    { id: 'gone', type: 'chart', chartType: 'line', data: { categories: [], series: [] }, x: 0, y: 0, w: 10, h: 10, anim: 'fade', animAt: 5 },
    { id: 'b', type: 'shape', shape: 'rect', fill: '#ff0000', x: 50, y: 50, w: 20, h: 20, anim: 'appear', animAt: 1 },
    { id: 'c', type: 'text', x: 5, y: 35, w: 60, h: 10, text: 'Second point', anim: 'fade', animAt: 3 },
  ] }, { id: 's2', items: [{ id: 'x', type: 'text', x: 5, y: 5, w: 60, h: 10, text: 'Still' }] }] };
  const buf = await powerPointFromDeck(deck);
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  assert.ok(xml.indexOf('<p:transition') < xml.indexOf('<p:timing>'), 'the transition comes before the timing, as PowerPoint orders them');
  // Each effect points at the right shape: its text (or the rectangle's own geometry) is in that shape.
  const shapes = Object.fromEntries([...xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)].map((m) => [/<p:cNvPr id="(\d+)"/.exec(m[1])?.[1], /<a:t>([^<]*)<\/a:t>/.exec(m[1])?.[1] || /prstGeom prst="(\w+)"/.exec(m[1])?.[1]]));
  assert.deepEqual(animationsOf(xml).map((e) => [shapes[e.spid], e.anim]), [['rect', 'appear'], ['First point', 'fly'], ['Second point', 'fade']]);
  assert.equal(/<p:timing>/.test(await zip.file('ppt/slides/slide2.xml').async('string')), false);
  const back = await deckFromPowerPoint(buf, { savePicture: async () => null });
  const got = back.slides[0].items.filter((it) => it.anim).sort((a, b) => a.animAt - b.animAt).map((it) => [it.text || it.shape, it.anim, it.animAt]);
  assert.deepEqual(got, [['rect', 'appear', 1], ['First point', 'fly', 2], ['Second point', 'fade', 3]]);
  // Effects Slides doesn't have come in as a fade.
  assert.deepEqual(animationsOf('<p:timing><p:cTn id="5" presetID="53" presetClass="entr"><p:spTgt spid="7"/></p:cTn></p:timing>'), [{ spid: '7', anim: 'fade' }]);
});
