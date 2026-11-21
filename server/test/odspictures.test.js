// Pictures over the cells in OpenDocument spreadsheets, against LibreOffice: our .ods ties each picture to the cell its
// corner is over (as LibreOffice does), LibreOffice puts it in that cell at that spot, and files LibreOffice makes
// (from Excel files made by openpyxl) open with their pictures, and their charts, where Excel has them.
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { odsFromSheet, sheetFromOds } from '../src/office/ods.js';
import { sheetFromExcel } from '../src/office/excel.js';

const hasPython = spawnSync('python3', ['-c', 'import openpyxl, PIL']).status === 0;
let seed = Number(process.env.SEED) || 20261121;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const col = (i) => String.fromCharCode(65 + i);
const python = (code, input) => { const r = spawnSync('python3', ['-I', '-c', code], { input, maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw new Error(String(r.stderr)); return JSON.parse(r.stdout); };
// A small PNG of this size (one colour), made by Pillow.
const pngs = (sizes) => python(`
import sys, json, io, base64
from PIL import Image
out = []
for w, h in json.load(sys.stdin):
    b = io.BytesIO(); Image.new('RGB', (w, h), (w % 256, h % 256, 90)).save(b, 'PNG'); out.append(base64.b64encode(b.getvalue()).decode())
print(json.dumps(out))`, JSON.stringify(sizes)).map((b) => Buffer.from(b, 'base64'));

// Random sheets: some columns wider, some rows taller, one to three pictures anywhere in the first 8 columns and 40 rows.
function books(n) {
  return Array.from({ length: n }, () => {
    const colWidths = {}, rowHeights = {};
    for (let c = 0; c < 8; c++) if (rnd() < 0.3) colWidths[col(c)] = int(40, 260);
    for (let r = 1; r <= 40; r++) if (rnd() < 0.15) rowHeights[String(r)] = int(18, 90);
    const pictures = {};
    for (let k = 0; k < int(1, 3); k++) pictures[`p${k}`] = { file: `f${k}`, alt: `Picture ${k} & co`, x: 46 + int(0, 700), y: 24 + int(0, 900), w: int(8, 300), h: int(8, 200) };
    return { sheets: [{ name: 'Sheet1', cells: { A1: 'x' }, colWidths, rowHeights, pictures }] };
  });
}
// Which cell a spot is over, and how far into it, on Sheets' grid (as Excel anchors a picture).
const cellAt = (sheet, x, y) => {
  let c = 0, cx = x - 46, r = 0, cy = y - 24;
  for (let w; cx >= (w = sheet.colWidths?.[col(c)] ?? 100); c++) cx -= w;
  for (let h; cy >= (h = sheet.rowHeights?.[String(r + 1)] ?? 24); r++) cy -= h;
  return { col: c, row: r, colOff: cx, rowOff: cy };
};
const cellAtOf = cellAt;

test('20 random sheets with pictures, to .ods and back: every picture where it was, its size and alt text', { skip: !hasPython && 'no Pillow here' }, async () => {
  for (const book of books(20)) {
    const pics = Object.values(book.sheets[0].pictures), data = pngs(pics.map((p) => [p.w, p.h]));
    const ods = await odsFromSheet(book, { pictureData: async (id) => ({ data: data[Number(id.slice(1))], mime: 'image/png' }) });
    const saved = [];
    const back = await sheetFromOds(ods, { savePicture: async (name, d, mime) => { saved.push({ d, mime }); return `g${saved.length - 1}`; } });
    const got = Object.values(back.sheets[0].pictures || {});
    assert.equal(got.length, pics.length);
    for (const [k, p] of pics.entries()) {
      const g = got.find((q) => q.alt === p.alt); // (in the file in the order of their cells)
      assert.deepEqual([g.x, g.y, g.w, g.h, g.alt], [p.x, p.y, p.w, p.h, p.alt], JSON.stringify(book.sheets[0]));
      assert.ok(saved[Number(g.file.slice(1))].d.equals(data[k]), 'the same picture');
    }
  }
});

test('and opened by LibreOffice (saved by it as .xlsx, read by openpyxl): each picture in the same cell, at the same spot, the same size', { skip: (!hasSoffice || !hasPython) && 'no LibreOffice or Pillow here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odspics-'));
  const list = books(12);
  const files = [];
  for (const [n, book] of list.entries()) {
    const pics = Object.values(book.sheets[0].pictures), data = pngs(pics.map((p) => [p.w, p.h]));
    fs.writeFileSync(path.join(dir, `b${n}.ods`), await odsFromSheet(book, { pictureData: async (id) => ({ data: data[Number(id.slice(1))], mime: 'image/png' }) }));
    files.push(path.join(dir, `b${n}.ods`));
  }
  soffice(['--headless', '--convert-to', 'xlsx', '--outdir', dir, ...files]);
  // (and saved by LibreOffice as .ods again, in a folder of its own: each picture's size as LibreOffice has it)
  fs.mkdirSync(path.join(dir, 'again'));
  soffice(['--headless', '--convert-to', 'ods', '--outdir', path.join(dir, 'again'), ...files]);
  const read = python(`
import sys, json, openpyxl
out = []
for f in json.load(sys.stdin):
    ws = openpyxl.load_workbook(f).active
    out.append([{ 'col': i.anchor._from.col, 'row': i.anchor._from.row, 'colOff': i.anchor._from.colOff / 9525, 'rowOff': i.anchor._from.rowOff / 9525, 'ext': [i.anchor.ext.width / 9525, i.anchor.ext.height / 9525] if getattr(i.anchor, 'ext', None) else None, 'to': [i.anchor.to.col, i.anchor.to.colOff / 9525, i.anchor.to.row, i.anchor.to.rowOff / 9525] if getattr(i.anchor, 'to', None) else None } for i in ws._images])
print(json.dumps(out))`, JSON.stringify(files.map((f) => f.replace(/\.ods$/, '.xlsx'))));
  for (const [n, book] of list.entries()) {
    const sheet = book.sheets[0], pics = Object.values(sheet.pictures);
    assert.equal(read[n].length, pics.length, `book ${n}: every picture`);
    const want = pics.map((p) => ({ ...cellAt(sheet, p.x, p.y), w: p.w, h: p.h })).sort((a, b) => a.row - b.row || a.col - b.col || a.colOff - b.colOff);
    const got = [...read[n]].sort((a, b) => a.row - b.row || a.col - b.col || a.colOff - b.colOff);
    for (const [k, w] of want.entries()) {
      const g = got[k];
      assert.deepEqual([g.col, g.row], [w.col, w.row], `book ${n}: ${JSON.stringify({ want: w, got: g, sheet })}`);
      for (const f of ['colOff', 'rowOff']) assert.ok(Math.abs(g[f] - w[f]) <= 2, `book ${n} ${f}: ${g[f]} vs ${w[f]}`);
    }
    const again = Object.values((await sheetFromOds(fs.readFileSync(path.join(dir, 'again', `b${n}.ods`)), { savePicture: async () => 'f' })).sheets[0].pictures || {});
    assert.deepEqual(again.map((p) => [p.alt, p.w, p.h]).sort(), pics.map((p) => [p.alt, p.w, p.h]).sort(), `book ${n}: the sizes, as LibreOffice saves them`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Excel files with pictures and charts made by openpyxl, saved by LibreOffice as .ods, open with each picture and chart where the Excel file has it', { skip: (!hasSoffice || !hasPython) && 'no LibreOffice or Pillow here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odspics-'));
  const plans = Array.from({ length: 8 }, () => ({
    widths: Object.fromEntries([0, 1, 2, 3, 4, 5].filter(() => rnd() < 0.4).map((c) => [col(c), int(6, 30)])),
    pics: Array.from({ length: int(1, 3) }, () => ({ at: `${col(int(0, 7))}${int(1, 30)}`, w: int(8, 200), h: int(8, 150) })),
    chart: `${col(int(0, 7))}${int(1, 30)}`,
  }));
  const xlsx = python(`
import sys, json, io, base64, openpyxl
from openpyxl.drawing.image import Image
from openpyxl.chart import BarChart, Reference
from PIL import Image as P
out = []
for plan in json.load(sys.stdin):
    wb = openpyxl.Workbook(); ws = wb.active; ws['A1'] = 1; ws['A2'] = 2
    for c, w in plan['widths'].items(): ws.column_dimensions[c].width = w
    for p in plan['pics']:
        b = io.BytesIO(); P.new('RGB', (p['w'], p['h']), (200, 40, 40)).save(b, 'PNG'); b.seek(0); ws.add_image(Image(b), p['at'])
    ch = BarChart(); ch.add_data(Reference(ws, min_col=1, min_row=1, max_row=2)); ws.add_chart(ch, plan['chart'])
    o = io.BytesIO(); wb.save(o); out.append(base64.b64encode(o.getvalue()).decode())
print(json.dumps(out))`, JSON.stringify(plans));
  const files = xlsx.map((b, n) => { const f = path.join(dir, `x${n}.xlsx`); fs.writeFileSync(f, Buffer.from(b, 'base64')); return f; });
  soffice(['--headless', '--convert-to', 'ods', '--outdir', dir, ...files]);
  const save = async () => 'f';
  for (const [n, f] of files.entries()) {
    const fromExcel = (await sheetFromExcel(fs.readFileSync(f), { savePicture: save })).sheets[0];
    const fromOds = (await sheetFromOds(fs.readFileSync(f.replace(/\.xlsx$/, '.ods')), { savePicture: save })).sheets[0];
    // Each the same distance into the same cell (LibreOffice turns Excel's column widths into its own units, a few
    // pixels off, so the cells, not the pixels from the corner, are what must agree), and the same size.
    const place = (sh, o) => Object.values(o || {}).map((p) => ({ ...cellAtOf(sh, p.x, p.y), w: p.w, h: p.h })).sort((a, b) => a.row - b.row || a.col - b.col);
    const [a, b] = [place(fromExcel, fromExcel.pictures), place(fromOds, fromOds.pictures)];
    assert.equal(b.length, plans[n].pics.length, `book ${n}: every picture`);
    a.forEach((p, k) => {
      assert.deepEqual([b[k].col, b[k].row], [p.col, p.row], `book ${n} picture ${k}: ${JSON.stringify([a, b])}`);
      for (const f of ['colOff', 'rowOff', 'w', 'h']) assert.ok(Math.abs(p[f] - b[k][f]) <= 2, `book ${n} picture ${k} ${f}: ${JSON.stringify([a, b])}`);
    });
    const [ca, cb] = [place(fromExcel, fromExcel.charts), place(fromOds, fromOds.charts)];
    assert.equal(cb.length, 1, `book ${n}: the chart`);
    assert.deepEqual([cb[0].col, cb[0].row], [ca[0].col, ca[0].row], `book ${n} chart: ${JSON.stringify([ca, cb])}`); // (where it is: LibreOffice gives it its own size)
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
