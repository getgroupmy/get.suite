import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sheetDocFromJson, jsonFromSheetDoc, applySheetJson } from './collabsync.js';

test('the browser\'s copy matches the server\'s', () => {
  const server = fs.readFileSync(new URL('../../../server/src/collabdoc.js', import.meta.url), 'utf8');
  const mine = fs.readFileSync(new URL('./collabsync.js', import.meta.url), 'utf8');
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

test('pictures over the cells go through the shared form and back', () => {
  const pictures = { p1: { file: 'f1', alt: 'Logo', x: 246, y: 72, w: 120, h: 60 } };
  const doc = sheetDocFromJson({ sheets: [{ name: 'S', cells: { A1: '1' }, colWidths: {}, pictures }] });
  assert.deepEqual(jsonFromSheetDoc(doc).sheets[0].pictures, pictures);
  const j = jsonFromSheetDoc(doc);
  j.sheets[0].pictures = { p1: { ...pictures.p1, x: 346 } };
  applySheetJson(doc, j);
  assert.equal(jsonFromSheetDoc(doc).sheets[0].pictures.p1.x, 346);
  delete j.sheets[0].pictures;
  applySheetJson(doc, j);
  assert.equal(jsonFromSheetDoc(doc).sheets[0].pictures, undefined);
});
