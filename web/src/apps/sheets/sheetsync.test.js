import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sheetDocFromJson, jsonFromSheetDoc, applySheetJson } from './sheetsync.js';

test('the browser\'s copy matches the server\'s', () => {
  const server = fs.readFileSync(new URL('../../../../server/src/collabdoc.js', import.meta.url), 'utf8');
  const mine = fs.readFileSync(new URL('./sheetsync.js', import.meta.url), 'utf8');
  assert.equal(mine.slice(mine.indexOf('// ---- spreadsheets:')), server.slice(server.indexOf('// ---- spreadsheets:')));
});

test('editing applies only the changed cells', () => {
  const doc = sheetDocFromJson({ sheets: [{ name: 'S', cells: { A1: '1', A2: '2' }, colWidths: {} }] });
  let changes = 0;
  doc.on('update', () => changes++);
  const j = jsonFromSheetDoc(doc);
  j.sheets[0].cells.A2 = '3';
  applySheetJson(doc, j);
  applySheetJson(doc, j); // nothing new: no change
  assert.equal(changes, 1);
  assert.equal(jsonFromSheetDoc(doc).sheets[0].cells.A2, '3');
});
