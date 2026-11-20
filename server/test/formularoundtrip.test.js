// Formulas through LibreOffice: a book written as .xlsx and as .ods, saved again by LibreOffice in the same format and read
// back, has the same formulas (references, sheets with spaces, a named range, newer functions, text with quotes, LET…).
// And formulas read from files are tidied: function names in capitals, sheet names as the sheets are named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { excelFromSheet, sheetFromExcel } from '../src/office/excel.js';
import { odsFromSheet, sheetFromOds } from '../src/office/ods.js';
import { tidyFormula } from '../src/office/formulatidy.js';

const FX = ['=SUM(A1:A3)', '=$A$1+A$2+$A3', "='Other sheet'!B2*2", '=SUM(Other!A1:A3)', '=Rate*A1', '=IFERROR(VLOOKUP(A1,Other!A1:B3,2,FALSE),"-")', '=TEXTJOIN(", ",TRUE,A1:A3)',
  '=IFS(A1>1,"a",TRUE,"b")', '=XLOOKUP(2,A1:A3,A1:A3)', '=CONCAT("a","b")', '=SUMIFS(A1:A3,A1:A3,">1")', '="say ""hi"""', '=A1&" & "&A2', '=-A1^2', '=(A1+A2)*A3%', '=A1:A3*2',
  '=ROUND(A1/3,2)', '=NETWORKDAYS.INTL(A1,A2,11)', '=STDEV.S(A1:A3)', '=LET(x,A1,x*2)', '=SUM(A:A)', '=COUNTIF(A1:A3,"<>2")', '=MAX(Other!A:A)', '=INDIRECT("A"&2)', '=TODAY()-A1'];
const book = () => ({ sheets: [{ name: 'Main', names: { Rate: 'A2' }, cells: { A1: '1', A2: '2', A3: '3', ...Object.fromEntries(FX.map((f, i) => [`C${i + 1}`, f])) } },
  { name: 'Other sheet', cells: { B2: '5' } }, { name: 'Other', cells: { A1: '1', B1: 'x', A2: '2', B2: 'y', A3: '3', B3: 'z' } }] });

test('formulas read from files: function names in capitals, sheet names as the sheets are named', () => {
  const names = ['Main', 'Other', 'Other sheet'];
  assert.equal(tidyFormula('=xlookup(2,A1:A3,A1:A3)', names), '=XLOOKUP(2,A1:A3,A1:A3)');
  assert.equal(tidyFormula('=networkdays.intl(A1,A2,11)', names), '=NETWORKDAYS.INTL(A1,A2,11)');
  assert.equal(tidyFormula('=MAX(other!A:A)', names), '=MAX(Other!A:A)');
  assert.equal(tidyFormula("='other sheet'!B2", names), "='Other sheet'!B2");
  assert.equal(tidyFormula('="xlookup(1)"&lower("a")', names), '="xlookup(1)"&LOWER("a")', 'text left as it is');
  assert.equal(tidyFormula('=Rate*A1', names), '=Rate*A1', 'names left as they are');
});

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
for (const [ext, write, read] of [['xlsx', excelFromSheet, sheetFromExcel], ['ods', odsFromSheet, sheetFromOds]]) {
  test(`through LibreOffice (.${ext}): the formulas and the named range come back as they were`, { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxrt-'));
    fs.writeFileSync(path.join(dir, `in.${ext}`), await write(book()));
    execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', ext, '--outdir', path.join(dir, 'out'), path.join(dir, `in.${ext}`)], { stdio: 'ignore', timeout: 120000 });
    const back = await read(fs.readFileSync(path.join(dir, 'out', `in.${ext}`)));
    const main = back.sheets.find((s) => s.name === 'Main');
    assert.deepEqual(FX.map((f, i) => main.cells[`C${i + 1}`]), FX);
    assert.deepEqual(main.names, { Rate: 'A2' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
