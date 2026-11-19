// Sheets moved, copied and removed while people edit together: each sheet's contents go with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sheetDocFromJson, jsonFromSheetDoc, applySheetJson } from '../src/collabdoc.js';

const sheets = [
  { name: 'Budget', tabColor: '#e53935', cells: { A1: 'Rent', B1: '900' }, colWidths: { A: 140 }, frozen: { rows: 1, cols: 0 }, charts: { c1: { id: 'c1', type: 'line', range: 'A1:B1' } }, rules: [{ id: 'r', range: 'B1:B9', when: 'gt', value: '5', fill: '#fce8e6' }] },
  { name: 'Notes', cells: { A1: 'Hello' }, colWidths: {}, notes: { A1: 'a note' } },
  { name: 'Plan', cells: { A1: '=Budget!B1*2' }, colWidths: {}, validations: [{ id: 'v', type: 'checkbox', range: 'C1:C3' }] },
];
const shape = (d) => d.sheets.map((s) => JSON.stringify({ name: s.name, tabColor: s.tabColor, cells: s.cells, colWidths: s.colWidths, frozen: s.frozen, charts: s.charts, rules: s.rules, notes: s.notes, validations: s.validations }));

test('moving a sheet: every sheet keeps its own contents in its new place', () => {
  const doc = sheetDocFromJson({ sheets });
  const moved = [sheets[1], sheets[2], sheets[0]];
  applySheetJson(doc, { sheets: moved });
  assert.deepEqual(shape(jsonFromSheetDoc(doc)), shape({ sheets: moved }));
});

test('copying a sheet next to it, and removing one: the others are untouched', () => {
  const doc = sheetDocFromJson({ sheets });
  const copy = { ...JSON.parse(JSON.stringify(sheets[0])), name: 'Copy of Budget', charts: { n1: { id: 'n1', type: 'line', range: 'A1:B1' } } };
  const withCopy = [sheets[0], copy, sheets[1], sheets[2]];
  applySheetJson(doc, { sheets: withCopy });
  assert.deepEqual(shape(jsonFromSheetDoc(doc)), shape({ sheets: withCopy }));
  const removed = [sheets[0], copy, sheets[2]];
  applySheetJson(doc, { sheets: removed });
  assert.deepEqual(shape(jsonFromSheetDoc(doc)), shape({ sheets: removed }));
});
