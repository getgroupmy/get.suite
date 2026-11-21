import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sheetPrintHtml, usedArea, cssOf } from './sheetprint.js';
import { mergeLayout } from './merge.js';

test('the used area of a sheet', () => {
  assert.deepEqual(usedArea(['B2', 'D5', 'C1']), { c1: 1, r1: 0, c2: 3, r2: 4 });
  assert.equal(usedArea([]), null);
});

test('styles become safe CSS', () => {
  assert.equal(cssOf({ fontWeight: 700, color: '#ff0000', textAlign: 'right', paddingLeft: 4 }), 'font-weight:700;color:#ff0000;text-align:right;padding-left:4px');
  assert.equal(cssOf({ background: 'url(https://x)', color: 'red;}body{x' }), '', 'nothing that loads or breaks out');
});

test('a printed sheet: shown values, formatting, merges, hidden rows and columns left out', () => {
  const cells = { A1: 'Item', B1: 'Price', C1: 'secret', A2: '<b>Bolts</b>', B2: 'RM 1.50', A3: 'hidden row', A4: 'Total', B4: 'RM 9' };
  const html = sheetPrintHtml({
    title: 'Quote', area: { c1: 0, r1: 0, c2: 2, r2: 3 }, text: (k) => cells[k] ?? '', style: (k) => (k === 'A1' ? { fontWeight: 700 } : {}),
    layout: mergeLayout(['A4:B4']), hiddenRows: new Set([2]), hiddenCols: new Set([2]), landscape: true,
  });
  assert.match(html, /size:A4 landscape/);
  assert.match(html, /<td style="font-weight:700">Item<\/td><td>Price<\/td><\/tr>/);
  assert.match(html, /&lt;b&gt;Bolts&lt;\/b&gt;/, 'escaped');
  assert.doesNotMatch(html, /secret|hidden row/);
  assert.match(html, /<td colspan="2">Total<\/td><\/tr>/, 'the merge spans what is printed');
  assert.equal((html.match(/<col /g) || []).length, 2);
  assert.doesNotMatch(sheetPrintHtml({ title: 'x', area: { c1: 0, r1: 0, c2: 0, r2: 0 }, text: () => '', gridlines: false }), /border:1px/);
});

test('pictures and charts over the cells print in the cell their corner is over, as far in; pictures load from this server only', () => {
  const html = sheetPrintHtml({ title: 'T', area: { c1: 0, r1: 0, c2: 3, r2: 3 }, text: (k) => k,
    overlays: [{ key: 'C2', ox: 10, oy: 4, w: 120, h: 60, html: '<img src="/api/files/f/pictures/p" alt="Logo">' }, { key: 'B4', ox: 0, oy: 0, w: 300, h: 200, chart: true, html: '<p>Sales</p><svg role="img"></svg>' }] });
  assert.match(html, /<td class="has-over">C2<div class="over" style="left:10px;top:4px;width:120px;height:60px"><img src="\/api\/files\/f\/pictures\/p" alt="Logo"><\/div><\/td>/);
  assert.match(html, /<td class="has-over">B4<div class="over chart" style="left:0px;top:0px;width:300px;height:200px"><p>Sales<\/p><svg role="img"><\/svg><\/div><\/td>/);
  assert.match(html, /img-src 'self'/);
  assert.equal((html.match(/class="over/g) || []).length, 2);
  assert.doesNotMatch(sheetPrintHtml({ title: 'T', area: { c1: 0, r1: 0, c2: 1, r2: 1 }, text: () => '' }), /class="has-over"/, 'nothing when there are none');
});

test('a sheet as a table for an email: values as shown, merges, hidden rows left out, the look on the text', async () => {
  const { sheetEmailHtml } = await import('./sheetprint.js');
  const shown = { A1: 'Item', B1: 'Cost', A2: 'Chairs', B2: '$1,200.00', A3: 'Secret', B3: '1', A4: 'Total <all>', B4: '$1,200.00', A5: 'Note across' };
  const fmt = { B2: { textAlign: 'right' }, A4: { fontWeight: 700, color: '#c00000' }, B4: { fontStyle: 'italic', background: '#ffff00', textAlign: 'right', textDecoration: 'underline line-through' }, A2: { color: 'url(x)' } };
  const layout = mergeLayout(['A5:B5']);
  const html = sheetEmailHtml({ area: { c1: 0, r1: 0, c2: 1, r2: 4 }, text: (k) => shown[k] ?? '', style: (k) => fmt[k], layout, hiddenRows: new Set([2]), header: true });
  assert.equal(html, '<table>'
    + '<tr><th><p><strong>Item</strong></p></th><th><p><strong>Cost</strong></p></th></tr>'
    + '<tr><td><p>Chairs</p></td><td><p style="text-align: right">$1,200.00</p></td></tr>'
    + '<tr><td><p><strong><span style="color: #c00000">Total &lt;all&gt;</span></strong></p></td><td><p style="text-align: right"><em><u><s><span style="background-color: #ffff00">$1,200.00</span></s></u></em></p></td></tr>'
    + '<tr><td colspan="2"><p>Note across</p></td></tr>'
    + '</table>');
  // Without a header row: plain cells.
  assert.match(sheetEmailHtml({ area: { c1: 0, r1: 0, c2: 0, r2: 0 }, text: () => 'Item' }), /^<table><tr><td><p>Item<\/p><\/td><\/tr><\/table>$/);
});
