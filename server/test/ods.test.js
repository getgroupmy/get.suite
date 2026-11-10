import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
const { odsFromSheet, sheetFromOds, formulaToOds, formulaFromOds, ODS_MIME } = await import('../src/office/ods.js');

test('formulas: Sheets ↔ OpenFormula (references in brackets, other sheets, ";" between arguments, strings left alone)', () => {
  assert.equal(formulaToOds('=SUM(A1:B2,Other!C3)'), 'of:=SUM([.A1:.B2];[$Other.C3])');
  assert.equal(formulaToOds("='My sheet'!$A$1*2"), "of:=[$'My sheet'.$A$1]*2");
  assert.equal(formulaToOds('=IF(A1>1,"a, b; A1","c")'), 'of:=IF([.A1]>1;"a, b; A1";"c")');
  assert.equal(formulaToOds('=SUM({1,2;3,4})'), 'of:=SUM({1;2|3;4})');
  assert.equal(formulaToOds('=LOG10(100)+ATAN2(1,1)'), 'of:=LOG10(100)+ATAN2(1;1)', 'function names with digits are not cells');
  assert.equal(formulaFromOds('of:=SUM([.A1:.B2];[$Other.C3])'), '=SUM(A1:B2,Other!C3)');
  assert.equal(formulaFromOds("of:=[$'My sheet'.$A$1]*2"), "='My sheet'!$A$1*2");
  assert.equal(formulaFromOds('of:=SUM([.A:.A])'), '=SUM(A:A)');
  assert.equal(formulaFromOds('of:=SUM({1;2|3;4})'), '=SUM({1,2;3,4})');
  assert.equal(formulaFromOds('of:=IF([.A1]>1;"x;[.B2]";"y")'), '=IF(A1>1,"x;[.B2]","y")');
  assert.equal(formulaFromOds('oooc:=[.A1]+1'), '=A1+1', 'older OpenOffice files');
});

const book = { sheets: [
  { name: 'Sales', cells: { A1: 'Item', B1: 'Amount', A2: 'Pens', B2: '4.5', A3: 'Ink', B3: '10', A4: 'Total', B4: '=SUM(B2:B3)', C2: '=B2/B4', D1: '2026-11-12', D2: 'TRUE', A6: 'line1\nline2' },
    formats: { A1: { b: 1, i: 1, fill: '#ffeeaa', color: '#cc0000' }, B2: { num: 'currency', cur: 'EUR', dp: 2 }, C2: { num: 'percent', dp: 1 }, B4: { b: 1, bd: 'tb', align: 'right', wrap: 1 } },
    colWidths: { A: 180 }, rowHeights: { 1: 40 }, merges: ['A6:B6'], frozen: { rows: 1, cols: 1 }, notes: { B4: 'Checked by Kim' }, hide: { cols: [4], rows: [7] } },
  { name: 'Other sheet', cells: { A1: "='Sales'!B4*2" } },
] };

test('.ods out: a file LibreOffice recognises, with typed values, formulas, styles and the frozen view', async () => {
  const buf = await odsFromSheet(book);
  const zip = await JSZip.loadAsync(buf);
  assert.equal(Object.keys(zip.files)[0], 'mimetype');
  assert.equal(await zip.file('mimetype').async('string'), ODS_MIME);
  const xml = await zip.file('content.xml').async('string');
  assert.match(xml, /<table:table table:name="Sales">/);
  assert.match(xml, /<table:table table:name="Other sheet">/);
  assert.match(xml, /table:formula="of:=SUM\(\[\.B2:\.B3\]\)"/);
  assert.match(xml, /table:formula="of:=\[\$'Sales'\.B4\]\*2"|table:formula="of:=\[\$&apos;Sales&apos;\.B4\]\*2"/);
  assert.match(xml, /office:value-type="currency" office:value="4\.5" office:currency="EUR"/);
  assert.match(xml, /office:value-type="date" office:date-value="2026-11-12"/);
  assert.match(xml, /office:value-type="boolean" office:boolean-value="true"/);
  assert.match(xml, /table:number-columns-spanned="2" table:number-rows-spanned="1"[^>]*>[\s\S]*?<text:p>line1<\/text:p><text:p>line2<\/text:p>[\s\S]*?<table:covered-table-cell\/>/);
  assert.match(xml, /<office:annotation><text:p>Checked by Kim<\/text:p><\/office:annotation>/);
  assert.match(xml, /<number:currency-style[^>]*><number:currency-symbol>EUR<\/number:currency-symbol>/);
  assert.match(xml, /<number:percentage-style[^>]*><number:number number:decimal-places="1"/);
  assert.match(xml, /fo:background-color="#ffeeaa"[\s\S]*?fo:font-weight="bold" fo:font-style="italic"[^>]*fo:color="#cc0000"/);
  assert.match(xml, /table:visibility="collapse"/);
  assert.match(xml, /style:column-width="4\.763cm"/);
  const settings = await zip.file('settings.xml').async('string');
  assert.match(settings, /config:name="Sales">[\s\S]*HorizontalSplitMode" config:type="short">2[\s\S]*VerticalSplitPosition" config:type="int">1/);
});

test('.ods in: what went out comes back', async () => {
  const [s, o] = (await sheetFromOds(await odsFromSheet(book))).sheets;
  assert.equal(s.name, 'Sales');
  assert.deepEqual(s.cells, book.sheets[0].cells);
  assert.deepEqual(s.formats.A1, { b: 1, i: 1, color: '#cc0000', fill: '#ffeeaa' });
  assert.deepEqual(s.formats.B2, { num: 'currency', cur: 'EUR', dp: 2 });
  assert.deepEqual(s.formats.C2, { num: 'percent', dp: 1 });
  assert.deepEqual(s.formats.B4, { b: 1, wrap: 1, bd: 'tb', align: 'right' });
  assert.deepEqual(s.formats.D1, { num: 'date', ds: 'iso' }, 'a date shows as one');
  assert.deepEqual(s.colWidths, { A: 180 });
  assert.deepEqual(s.rowHeights, { 1: 40 });
  assert.deepEqual(s.merges, ['A6:B6']);
  assert.deepEqual(s.frozen, { rows: 1, cols: 1 });
  assert.deepEqual(s.notes, { B4: 'Checked by Kim' });
  assert.deepEqual(s.hide, { rows: [7], cols: [4] });
  assert.deepEqual(o.cells, { A1: "='Sales'!B4*2" });
});

test('.ods in: repeated cells and rows as LibreOffice writes them; tables named in Sheets go out as ranges', async () => {
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';
  const zip = new JSZip();
  zip.file('mimetype', ODS_MIME);
  zip.file('content.xml', `<office:document-content ${NS}><office:body><office:spreadsheet><table:table table:name="Data">
    <table:table-column table:number-columns-repeated="1024"/>
    <table:table-row><table:table-cell office:value-type="float" office:value="7" table:number-columns-repeated="3"><text:p>7</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1021"/></table:table-row>
    <table:table-row table:number-rows-repeated="2"><table:table-cell office:value-type="string"><text:p>same</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1023"/></table:table-row>
    <table:table-row table:number-rows-repeated="1048572"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
  </table:table></office:spreadsheet></office:body></office:document-content>`);
  const [s] = (await sheetFromOds(await zip.generateAsync({ type: 'nodebuffer' }))).sheets;
  assert.deepEqual(s.cells, { A1: '7', B1: '7', C1: '7', A2: 'same', A3: 'same' });
  // A Sheets table (a named band) referred to by name goes out as the plain range.
  const t = await odsFromSheet({ sheets: [{ name: 'S', cells: { A1: 'Qty', A2: '2', A3: '3', B1: '=SUM(Orders[Qty])' }, bands: [{ name: 'Orders', range: 'A1:A3', head: '#dddddd' }] }] });
  const xml = await (await JSZip.loadAsync(t)).file('content.xml').async('string');
  assert.match(xml, /of:=SUM\(\[\.A2:\.A3\]\)/);
  assert.match(xml, /fo:background-color="#dddddd"[^/]*\/>(<style:paragraph-properties[^>]*\/>)?<style:text-properties fo:font-weight="bold"/);
  await assert.rejects(sheetFromOds(await new JSZip().file('a', 'b').generateAsync({ type: 'nodebuffer' })), /Not an OpenDocument spreadsheet/);
});
