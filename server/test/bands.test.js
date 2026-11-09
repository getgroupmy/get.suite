import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sheetDocFromJson, jsonFromSheetDoc, applySheetJson } from '../src/collabdoc.js';

const B = { id: 'b1', range: 'A1:C9', header: true, footer: false, head: '#4a86e8', odd: '#ffffff', even: '#e8f0fe', foot: '#c6dafc' };

test('alternating colours are kept in the shared spreadsheet, changed and removed', () => {
  const doc = sheetDocFromJson({ sheets: [{ name: 'S', cells: { A1: 'x' }, bands: [B] }] });
  assert.deepEqual(jsonFromSheetDoc(doc).sheets[0].bands, [B]);
  applySheetJson(doc, { sheets: [{ name: 'S', cells: { A1: 'x' }, bands: [{ ...B, even: '#f1f3f4' }] }] });
  assert.equal(jsonFromSheetDoc(doc).sheets[0].bands[0].even, '#f1f3f4');
  applySheetJson(doc, { sheets: [{ name: 'S', cells: { A1: 'x' } }] });
  assert.equal(jsonFromSheetDoc(doc).sheets[0].bands, undefined);
});

test('row heights are kept in the shared spreadsheet, and two people setting different rows both keep theirs', () => {
  const doc = sheetDocFromJson({ sheets: [{ name: 'S', cells: {}, rowHeights: { 2: 80 } }] });
  assert.deepEqual(jsonFromSheetDoc(doc).sheets[0].rowHeights, { 2: 80 });
  applySheetJson(doc, { sheets: [{ name: 'S', cells: {}, rowHeights: { 2: 80, 5: 40 } }] });
  assert.deepEqual(jsonFromSheetDoc(doc).sheets[0].rowHeights, { 2: 80, 5: 40 });
  applySheetJson(doc, { sheets: [{ name: 'S', cells: {}, rowHeights: null }] });
  assert.equal(jsonFromSheetDoc(doc).sheets[0].rowHeights, undefined, 'none left: not stored');
});
