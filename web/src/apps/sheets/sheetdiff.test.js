import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sheetChanges, changeTotals } from './sheetdiff.js';

test('spreadsheet changes: cells typed, changed and cleared; sheets added, renamed and removed', () => {
  const before = { sheets: [{ name: 'Budget', cells: { A1: 'Item', B2: '10', C3: '=B2*2', A10: 'x' } }, { name: 'Old', cells: { A1: '1' } }, { name: 'Notes', cells: {} }] };
  const after = { sheets: [{ name: 'Budget', cells: { A1: 'Item', B2: '12', A2: 'Rent', A10: 'x' } }, { name: 'Ideas', cells: {} }] };
  const ch = sheetChanges(before, after);
  assert.deepEqual(ch.map((s) => `${s.name}:${s.status}${s.was ? `<${s.was}` : ''}`), ['Budget:same', 'Ideas:renamed<Old', 'Notes:removed']);
  assert.deepEqual(ch[0].cells, [
    { key: 'A2', was: '', now: 'Rent', kind: 'add' },
    { key: 'B2', was: '10', now: '12', kind: 'edit' },
    { key: 'C3', was: '=B2*2', now: '', kind: 'del' },
  ], 'in reading order');
  assert.deepEqual(ch[1].cells, [{ key: 'A1', was: '1', now: '', kind: 'del' }]);
  assert.deepEqual(changeTotals(ch), { cells: 4, sheets: 2 });
  const grown = sheetChanges(before, { sheets: [...before.sheets, { name: 'New', cells: { B1: 'hi' } }] });
  assert.deepEqual(grown.map((s) => s.status), ['same', 'same', 'same', 'added']);
  assert.deepEqual(grown[3].cells, [{ key: 'B1', was: '', now: 'hi', kind: 'add' }]);
  assert.deepEqual(sheetChanges(after, after).every((s) => s.status === 'same' && !s.cells.length), true);
});

test('comparing results: formulas become what they come to, so a CSV export matches', async () => {
  const { asValues } = await import('./sheetdiff.js');
  const { bookEvaluator, display } = await import('./formula.js');
  const book = { sheets: [{ name: 'Costs', cells: { A1: 'Rent', B1: '1200', B2: '300', B3: '=SUM(B1:B2)' } }] };
  const csv = { sheets: [{ name: 'Costs', cells: { A1: 'Rent', B1: '1200', B2: '300', B3: '1500' } }] };
  const ev = (sheets, i) => bookEvaluator(sheets, i);
  assert.deepEqual(asValues(book, ev, display).sheets[0].cells.B3, '1500');
  assert.equal(changeTotals(sheetChanges(asValues(book, ev, display), csv)).cells, 0, 'the same results');
  assert.equal(changeTotals(sheetChanges(book, csv)).cells, 1, 'as typed, the formula differs');
});
