import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorOf, placeOf, movePictures } from './pictures.js';
import { applyStructure } from './structure.js';
import { colName } from './formula.js';

let seed = Number(process.env.SEED) || 20261121;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

test('a picture\'s place: the cell its corner is over and how far in, and back', () => {
  const colWidths = { B: 150 }, rowHeights = { 3: 60 };
  assert.deepEqual(anchorOf({ x: 46 + 100 + 150 + 7, y: 24 + 24 + 24 + 60 + 3 }, colWidths, rowHeights), { col: 2, row: 3, dx: 7, dy: 3 }, 'C4: past A (100) and B (150); rows 1, 2 (24) and 3 (60)');
  assert.deepEqual(anchorOf({ x: 0, y: 0 }, {}, {}), { col: 0, row: 0, dx: 0, dy: 0 }, 'over the headings: the first cell');
  for (let n = 0; n < 200; n++) {
    const cw = {}, rh = {};
    for (let c = 0; c < 10; c++) if (rnd() < 0.3) cw[colName(c)] = int(20, 300);
    for (let r = 1; r <= 30; r++) if (rnd() < 0.3) rh[String(r)] = int(16, 120);
    const p = { x: 46 + int(0, 1500), y: 24 + int(0, 1200) };
    assert.deepEqual(placeOf(anchorOf(p, cw, rh), cw, rh), { x: p.x, y: p.y });
  }
});

test('300 random sheets: rows and columns inserted, deleted and resized before a picture, it stays over the same cell, as far in', () => {
  for (let n = 0; n < 300; n++) {
    const colWidths = {}, rowHeights = {};
    for (let c = 0; c < 12; c++) if (rnd() < 0.3) colWidths[colName(c)] = int(30, 250);
    for (let r = 1; r <= 40; r++) if (rnd() < 0.2) rowHeights[String(r)] = int(16, 90);
    const p = { file: 'f', alt: 'Logo', x: 46 + int(0, 1100), y: 24 + int(0, 900), w: int(8, 300), h: int(8, 200) };
    const sheet = { name: 'S', cells: {}, colWidths, rowHeights, pictures: { p } };
    const was = anchorOf(p, colWidths, rowHeights);
    const axis = rnd() < 0.5 ? 'col' : 'row', key = axis === 'col' ? 'col' : 'row', off = axis === 'col' ? 'dx' : 'dy';
    const kind = int(0, 2);
    if (kind < 2) {
      const at = int(0, was[key] + 3), count = kind === 0 ? int(1, 3) : -int(1, 3);
      const after = applyStructure(sheet, { axis, at, count });
      const q = after.pictures.p, now = anchorOf(q, after.colWidths, after.rowHeights || {});
      assert.deepEqual([q.w, q.h, q.alt, q.file], [p.w, p.h, p.alt, p.file], 'only where it is changes');
      const other = key === 'col' ? 'row' : 'col', otherOff = off === 'dx' ? 'dy' : 'dx';
      assert.deepEqual([now[other], now[otherOff]], [was[other], was[otherOff]], 'the other way: as it was');
      if (count > 0) assert.deepEqual([now[key], now[off]], [was[key] >= at ? was[key] + count : was[key], was[off]], JSON.stringify({ at, count, axis, was, now }));
      else if (was[key] < at) assert.deepEqual([now[key], now[off]], [was[key], was[off]]);
      else if (was[key] >= at - count) assert.deepEqual([now[key], now[off]], [was[key] + count, was[off]]);
      else assert.deepEqual([now[key], now[off]], [at, 0], 'its cell deleted: at the corner of the cell where it was');
    } else {
      // A column or row before (or at) its cell resized.
      const i = int(0, was[key]), size = int(30, 260);
      const next = axis === 'col' ? { colWidths: { ...colWidths, [colName(i)]: size } } : { rowHeights: { ...rowHeights, [String(i + 1)]: size } };
      const q = movePictures(sheet.pictures, sheet, { ...sheet, ...next }).p;
      const now = anchorOf(q, { ...colWidths, ...next.colWidths }, { ...rowHeights, ...next.rowHeights });
      if (i < was[key] || size > was[off]) assert.deepEqual([now.col, now.row, now.dx, now.dy], [was.col, was.row, was.dx, was.dy], JSON.stringify({ i, size, axis, was, now }));
    }
  }
});

test('a sheet without pictures is left as it was', () => {
  const out = applyStructure({ name: 'S', cells: { A1: '1' } }, { axis: 'row', at: 0, count: 1 });
  assert.equal('pictures' in out, false);
});

test('charts and slicers move with their cells too; one with no place of its own is left as it is', () => {
  const sheet = { name: 'S', cells: { A1: '1', A2: '2' }, colWidths: {}, charts: { c: { type: 'column', range: 'A1:A2', x: 46 + 200 + 5, y: 24 + 48, w: 480, h: 300 }, old: { type: 'line', range: 'A1:A2' } }, slicers: { s: { range: 'A1:A2', col: 'A', hidden: [], x: 46 + 300, y: 24 + 24 * 6 } } };
  const out = applyStructure(sheet, { axis: 'row', at: 1, count: 3 });
  assert.deepEqual([out.charts.c.x, out.charts.c.y, out.charts.c.range], [251, 24 + 24 * 5, 'A1:A5'], 'C3 → C6, as far in; its range grown');
  assert.deepEqual([out.slicers.s.x, out.slicers.s.y], [346, 24 + 24 * 9]);
  assert.deepEqual(out.charts.old, { type: 'line', range: 'A1:A5' });
  const wider = applyStructure(sheet, { axis: 'col', at: 0, count: 1 });
  assert.equal(wider.charts.c.x, 251 + 100, 'a column before: 100 pixels on');
});

test('hidden and filtered-out rows and columns take no room on the sheet: a picture shows over the same cell, as far in, and is kept against all of them', async () => {
  const { toScreen, fromScreen } = await import('./pictures.js');
  for (let n = 0; n < 300; n++) {
    const colWidths = {}, rowHeights = {};
    for (let c = 0; c < 10; c++) if (rnd() < 0.3) colWidths[colName(c)] = int(30, 200);
    for (let r = 1; r <= 40; r++) if (rnd() < 0.2) rowHeights[String(r)] = int(16, 80);
    const sizes = { colWidths, rowHeights };
    const rows = new Set(Array.from({ length: int(0, 8) }, () => int(0, 35))), cols = new Set(Array.from({ length: int(0, 3) }, () => int(0, 8)));
    const p = { x: 46 + int(0, 900), y: 24 + int(0, 800), w: 50, h: 40 };
    const a = anchorOf(p, colWidths, rowHeights);
    if (rows.has(a.row) || cols.has(a.col)) continue; // (its own cell shown: the rest is checked below)
    const shown = toScreen(p, sizes, { rows, cols });
    // On the sheet as shown, it's that far from its cell's corner, which is the sum of the rows and columns shown before it.
    let x = 46, y = 24;
    for (let c = 0; c < a.col; c++) if (!cols.has(c)) x += colWidths[colName(c)] ?? 100;
    for (let r = 0; r < a.row; r++) if (!rows.has(r)) y += rowHeights[String(r + 1)] ?? 24;
    assert.deepEqual([shown.x, shown.y], [Math.round(x + a.dx), Math.round(y + a.dy)], JSON.stringify({ p, a, rows: [...rows], cols: [...cols] }));
    assert.deepEqual(fromScreen(shown, sizes, { rows, cols }), { ...p }, 'and back');
  }
  // Its own row hidden: it shows at the top of the next row shown.
  const p = { x: 46 + 10, y: 24 + 24 * 3 + 5 };
  assert.deepEqual(toScreen(p, {}, { rows: new Set([3]), cols: new Set() }), { x: 56, y: 24 + 24 * 3 });
  assert.equal(toScreen(p, {}, { rows: new Set(), cols: new Set() }), p, 'nothing hidden: as it is');
});
