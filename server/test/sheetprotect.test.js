import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brokenProtections, mayEdit, protectionsAt, rangeBox } from '../src/sheetprotect.js';
import { sheetDocFromJson, jsonFromSheetDoc, applySheetJson } from '../src/collabdoc.js';

const P = { id: 'p1', range: 'A1:B2', editors: ['ann'], by: 'olga', desc: 'Totals' };
const book = (cells, extra = {}) => ({ sheets: [{ name: 'Sheet1', cells, protected: [P], ...extra }] });

test('protected ranges: who may edit, and which cells they cover', () => {
  assert.deepEqual(rangeBox('b2:a1'), { c1: 0, r1: 0, c2: 1, r2: 1 });
  assert.equal(rangeBox('nope'), null);
  assert.ok(mayEdit(P, 'ann', 'owner') && mayEdit(P, 'olga', 'owner') && mayEdit(P, 'owner', 'owner'));
  assert.equal(mayEdit(P, 'bob', 'owner'), false);
  const sheet = { protected: [P, { id: 'p2', range: null, editors: [] }] };
  assert.deepEqual(protectionsAt(sheet, 'B2').map((p) => p.id), ['p1', 'p2']);
  assert.deepEqual(protectionsAt(sheet, 'C1').map((p) => p.id), ['p2']);
});

test('protected ranges: changes inside are refused for others, outside are fine', () => {
  const before = book({ A1: '1', C5: 'x' });
  assert.equal(brokenProtections(before, book({ A1: '1', C5: 'y', D9: 'new' }), 'bob', 'owner').length, 0);
  assert.equal(brokenProtections(before, book({ A1: '2', C5: 'x' }), 'bob', 'owner').length, 1);
  assert.equal(brokenProtections(before, book({ A1: '1', B2: 'added', C5: 'x' }), 'bob', 'owner').length, 1, 'filling an empty protected cell');
  assert.equal(brokenProtections(before, book({ C5: 'x' }), 'bob', 'owner').length, 1, 'clearing');
  assert.equal(brokenProtections(before, book({ A1: '1', C5: 'x' }, { formats: { A1: { bold: true } } }), 'bob', 'owner').length, 1, 'formatting');
  assert.equal(brokenProtections(before, book({ A1: '2' }), 'ann', 'owner').length, 0, 'a listed editor');
  assert.equal(brokenProtections(before, book({ A1: '2' }), 'owner', 'owner').length, 0, 'the owner');
  // Taking the protection off, changing who may edit, or deleting the sheet.
  assert.equal(brokenProtections(before, { sheets: [{ name: 'Sheet1', cells: { A1: '1' } }] }, 'bob', 'owner').length, 1);
  assert.equal(brokenProtections(before, book({ A1: '1' }, { protected: [{ ...P, editors: ['ann', 'bob'] }] }), 'bob', 'owner').length, 1);
  assert.equal(brokenProtections(before, { sheets: [] }, 'bob', 'owner').length, 1);
  // Rows inserted above move the protected cells: also refused.
  assert.equal(brokenProtections(before, book({ A2: '1', C6: 'x' }), 'bob', 'owner').length, 1);
});

test('protected ranges: whole sheets, warnings, and the shared form keeps them', () => {
  const whole = { id: 'w', range: null, editors: [], by: 'olga' };
  const b = { sheets: [{ name: 'Rates', cells: { Z99: '1' }, protected: [whole] }, { name: 'Free', cells: {} }] };
  assert.equal(brokenProtections(b, { sheets: [{ ...b.sheets[0], colWidths: { A: 200 } }, b.sheets[1]] }, 'bob', 'owner').length, 1);
  assert.equal(brokenProtections(b, { sheets: [{ ...b.sheets[0], name: 'Renamed' }, b.sheets[1]] }, 'bob', 'owner').length, 1);
  assert.equal(brokenProtections(b, { sheets: [b.sheets[0], { name: 'Free', cells: { A1: 'ok' } }] }, 'bob', 'owner').length, 0);
  const warn = { sheets: [{ name: 'S', cells: { A1: '1' }, protected: [{ ...P, warn: true }] }] };
  const changed = { sheets: [{ ...warn.sheets[0], cells: { A1: '2' } }] };
  assert.equal(brokenProtections(warn, changed, 'bob', 'owner').length, 0, 'the server lets warnings through');
  assert.equal(brokenProtections(warn, changed, 'bob', 'owner', { warnings: true }).length, 1, 'the browser asks');

  const doc = sheetDocFromJson(book({ A1: '1' }));
  assert.deepEqual(jsonFromSheetDoc(doc).sheets[0].protected, [P]);
  applySheetJson(doc, { sheets: [{ name: 'Sheet1', cells: { A1: '1' } }] });
  assert.equal(jsonFromSheetDoc(doc).sheets[0].protected, undefined);
});
