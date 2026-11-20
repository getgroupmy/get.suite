// Dates with a time, times on their own and their formats in .ods files: written as OpenDocument dates and times
// (with date and time styles from the format codes) and read back the same, also after LibreOffice saves the file again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { odsFromSheet, sheetFromOds } from '../src/office/ods.js';

const book = { sheets: [{ name: 'S', cells: { A1: '2026-11-20', A2: '2026-11-20 14:30', A3: String(14.5 / 24), A4: '2026-11-20 09:05:30' },
  formats: { A1: { num: 'date', ds: 'short' }, A2: { num: 'custom', code: 'dd/mm/yyyy hh:mm' }, A3: { num: 'custom', code: 'h:mm AM/PM' }, A4: { num: 'custom', code: 'd mmm yyyy hh:mm:ss' } } }] };
const check = (s) => {
  assert.deepEqual([s.cells.A1, s.cells.A2, Number(s.cells.A3).toFixed(6), s.cells.A4], ['2026-11-20', '2026-11-20 14:30', (14.5 / 24).toFixed(6), '2026-11-20 09:05:30']);
  assert.deepEqual(s.formats.A2, { num: 'custom', code: 'dd/mm/yyyy hh:mm' });
  assert.deepEqual(s.formats.A3, { num: 'custom', code: 'h:mm AM/PM' });
  assert.deepEqual(s.formats.A4, { num: 'custom', code: 'd mmm yyyy hh:mm:ss' });
};

test('a date and time and a time are OpenDocument dates and times, with their formats, and come back so', async () => {
  const buf = await odsFromSheet(book);
  const xml = await (await JSZip.loadAsync(buf)).file('content.xml').async('string');
  assert.match(xml, /office:value-type="date" office:date-value="2026-11-20T14:30:00"/);
  assert.match(xml, /office:value-type="time" office:time-value="PT14H30M00S"/);
  assert.match(xml, /<number:time-style [^>]*><number:hours\/><number:text>:<\/number:text><number:minutes number:style="long"\/><number:text> <\/number:text><number:am-pm\/>/);
  check((await sheetFromOds(buf)).sheets[0]);
});

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
test('through LibreOffice: saved again by it, the dates, times and formats come back the same', { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odsdates-'));
  fs.writeFileSync(path.join(dir, 'in.ods'), await odsFromSheet(book));
  fs.mkdirSync(path.join(dir, 'out'));
  execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'ods', '--outdir', path.join(dir, 'out'), path.join(dir, 'in.ods')], { stdio: 'ignore', timeout: 120000 });
  check((await sheetFromOds(fs.readFileSync(path.join(dir, 'out', 'in.ods')))).sheets[0]);
  fs.rmSync(dir, { recursive: true, force: true });
});
