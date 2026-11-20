// A sheet's look through files: formats (bold, italic, underline, strikethrough, colours, borders, alignment, wrap,
// currency), column widths, a row height, merged cells, frozen rows/columns, hidden rows/columns, a conditional format and
// a note come back the same from our own .xlsx and .ods, and after LibreOffice saves them again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { excelFromSheet, sheetFromExcel } from '../src/office/excel.js';
import { odsFromSheet, sheetFromOds } from '../src/office/ods.js';

const sheet = () => ({ name: 'Fmt', cells: { A1: 'Head', B1: 'Bold', A2: '1', B2: '2', A3: 'wrap me please', C1: 'merged', A5: 'note', D1: 'Status', D2: 'Open', E2: '75' },
  formats: { A1: { b: 1, i: 1, color: '#ff0000', fill: '#ffff00', align: 'center' }, B1: { u: 1, s: 1, bd: 'tblr' }, A2: { num: 'currency', cur: 'EUR', dp: 2 }, A3: { wrap: 1, va: 'top' } },
  colWidths: { A: 150, C: 60 }, rowHeights: { 3: 40 }, merges: ['C1:D1'], frozen: { rows: 1, cols: 1 }, hide: { rows: [7], cols: [5] },
  rules: [{ id: 'r1', range: 'E2:E9', when: 'gt', value: '50', fill: '#b7e1cd' }], notes: { A5: 'A note here' } });
const look = (s) => ({ formats: s.formats, colWidths: s.colWidths, rowHeights: s.rowHeights, merges: s.merges, frozen: s.frozen, hide: s.hide,
  rules: (s.rules || []).map(({ id, ...r }) => r), notes: s.notes });
const want = look(sheet());

for (const [ext, write, read] of [['xlsx', excelFromSheet, sheetFromExcel], ['ods', odsFromSheet, sheetFromOds]]) {
  test(`.${ext}: a sheet's look comes back the same (a 60px column too: it used to be lost in .xlsx)`, async () => {
    assert.deepEqual(look((await read(await write({ sheets: [sheet()] }))).sheets[0]), want);
  });
}

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
for (const [ext, write, read] of [['xlsx', excelFromSheet, sheetFromExcel], ['ods', odsFromSheet, sheetFromOds]]) {
  test(`through LibreOffice (.${ext}): saved again by it, the look comes back the same`, { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmtrt-'));
    fs.writeFileSync(path.join(dir, `in.${ext}`), await write({ sheets: [sheet()] }));
    execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', ext, '--outdir', path.join(dir, 'out'), path.join(dir, `in.${ext}`)], { stdio: 'ignore', timeout: 120000 });
    const got = look((await read(fs.readFileSync(path.join(dir, 'out', `in.${ext}`)))).sheets[0]);
    // LibreOffice without a window writes no view settings into .ods, where frozen rows and columns are kept (it does in .xlsx)
    const expected = { ...want };
    if (ext === 'ods') { delete got.frozen; delete expected.frozen; }
    assert.deepEqual(got, expected);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
