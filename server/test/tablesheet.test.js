// A table as a spreadsheet: the tables of figures in an email (layout tables and one-row tables left out), a sheet each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docFromHtml } from '../src/office/word.js';
import { tablesIn, sheetFromTables } from '../src/office/tablesheet.js';

test('the tables of figures in an email’s HTML, a sheet each; layout tables and one-row tables left out', () => {
  const html = `<table><tr><td>
      <p>Hello, here is the report.</p>
      <table><tr><th>Region</th><th>Sales</th></tr><tr><td>North</td><td>$1,200.00</td></tr><tr><td>South</td><td>15%</td></tr></table>
      <table><tr><td>Only one row</td><td>x</td></tr></table>
      <table><tr><td>Item</td><td>Qty</td></tr><tr><td>Bolts <b>M6</b></td><td>1,000</td></tr></table>
    </td></tr></table>`;
  const tables = tablesIn(docFromHtml(html));
  assert.deepEqual(tables, [
    { rows: [['Region', 'Sales'], ['North', '$1,200.00'], ['South', '15%']], header: true },
    { rows: [['Item', 'Qty'], ['Bolts M6', '1,000']], header: false },
  ]);
  const book = sheetFromTables(tables);
  assert.deepEqual(book.sheets.map((s) => s.name), ['Table 1', 'Table 2']);
  assert.deepEqual([book.sheets[0].cells.B2, book.sheets[0].formats.B2, book.sheets[0].cells.B3, book.sheets[0].frozen], ['1200', { num: 'currency', cur: 'USD', dp: 2 }, '0.15', { rows: 1, cols: 0 }]);
  assert.deepEqual([book.sheets[1].cells.B2, book.sheets[1].formats.A1], ['1000', undefined]);
  // One table: "Sheet1". None: nothing.
  assert.equal(sheetFromTables(tables.slice(0, 1)).sheets[0].name, 'Sheet1');
  assert.deepEqual(tablesIn(docFromHtml('<p>No tables here</p>')), []);
});
