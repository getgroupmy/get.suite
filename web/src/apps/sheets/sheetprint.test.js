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
