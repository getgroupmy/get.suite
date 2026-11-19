// Validation rules (numbers, dates, text length, email and web addresses, custom formulas) in .ods files both
// ways, as LibreOffice writes them, and through LibreOffice (.ods and .xlsx, each saved again in either).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { odsFromSheet, sheetFromOds } from '../src/office/ods.js';
import { excelFromSheet, sheetFromExcel } from '../src/office/excel.js';
import { ruleToOdsCondition, ruleFromOdsCondition } from '../src/office/odsrules.js';

const R = (range, check, strict, message) => ({ type: 'rule', range, check, strict, ...(message && { message }) });
const rules = [
  R('A2:A5', { kind: 'number', op: 'between', a: '1', b: '99' }, true, 'A quantity from 1 to 99'),
  R('B2:B5', { kind: 'whole', op: 'gte', a: '0' }, false),
  R('C2:C5', { kind: 'date', op: 'between', a: '2026-01-01', b: '2026-12-31' }, true),
  R('D2:D5', { kind: 'length', op: 'lte', a: '10' }, true, 'Ten letters at most'),
  R('E2:E5', { kind: 'email' }, true),
  R('F2:F5', { kind: 'url' }, false),
  R('G2:G5', { kind: 'formula', a: '=G2<=H2' }, true, 'Start before end'),
  R('I2:I5', { kind: 'number', op: 'ne', a: '5' }, false),
  R('J2:J5', { kind: 'date', op: 'lt', a: '2027-06-30' }, false),
  R('K2:K5', { kind: 'length', op: 'notBetween', a: '3', b: '5' }, false),
  R('L2:L5', { kind: 'whole', op: 'notBetween', a: '10', b: '20' }, true),
];
const sheet = { sheets: [{ name: 'Sheet1', cells: { A1: { v: 'Qty' } }, validations: rules.map((v, i) => ({ id: `r${i}`, ...v })) }] };
// Comparable: each rule's own fields, in one order.
const show = (s) => (s.sheets[0].validations || []).map((v) => JSON.stringify({ type: v.type, range: v.range, check: v.check, strict: v.strict, ...(v.message && { message: v.message }) }));
const want = rules.map((v) => JSON.stringify(v));

test('a rule as LibreOffice writes its condition, and back', () => {
  const cond = (v) => ruleToOdsCondition(v);
  assert.equal(cond(rules[0]), 'of:cell-content-is-decimal-number() and cell-content-is-between(1,99)');
  assert.equal(cond(rules[1]), 'of:cell-content-is-whole-number() and cell-content()>=0');
  assert.equal(cond(rules[2]), 'of:cell-content-is-date() and cell-content-is-between(46023,46387)', 'dates as day numbers');
  assert.equal(cond(rules[3]), 'of:cell-content-text-length()<=10');
  assert.equal(cond(rules[6]), 'of:is-true-formula([.G2]<=[.H2])');
  assert.equal(cond(rules[9]), 'of:cell-content-text-length-is-not-between(3,5)');
  assert.equal(cond({ type: 'rule', range: 'A1', check: { kind: 'number', op: 'gt', a: 'x' } }), null, 'no limit, no rule');
  for (const v of rules) assert.deepEqual({ ...ruleFromOdsCondition(cond(v), v), range: v.range }, v, v.range); // (the range is the cells naming it)
  // Other ways it may be written: semicolons, "<>", a date limit as text, the old prefix
  assert.deepEqual(ruleFromOdsCondition('oooc:cell-content-is-whole-number() and cell-content-is-between(1;5)').check, { kind: 'whole', op: 'between', a: '1', b: '5' });
  assert.deepEqual(ruleFromOdsCondition('of:cell-content-is-decimal-number() and cell-content()<>0').check, { kind: 'number', op: 'ne', a: '0' });
  assert.deepEqual(ruleFromOdsCondition('of:cell-content-is-date() and cell-content()>="2026-03-01"').check, { kind: 'date', op: 'gte', a: '2026-03-01' });
  assert.equal(ruleFromOdsCondition('of:cell-content-is-in-list("a";"b")'), null, 'a dropdown is not a rule');
});

test('.ods: rules go out as content validations (refused or with a warning, their message) and come back', async () => {
  const buf = await odsFromSheet(sheet);
  const xml = await (await JSZip.loadAsync(buf)).file('content.xml').async('string');
  assert.match(xml, /<table:content-validation table:name="val1" table:condition="of:cell-content-is-decimal-number\(\) and cell-content-is-between\(1,99\)" table:allow-empty-cell="true" table:base-cell-address="Sheet1\.A2"><table:error-message table:message-type="stop" table:title="Not valid" table:display="true"><text:p>A quantity from 1 to 99<\/text:p><\/table:error-message>/);
  assert.match(xml, /table:condition="of:cell-content-is-whole-number\(\) and cell-content\(\)&gt;=0"[^>]*><table:error-message table:message-type="warning" table:display="true"><\/table:error-message>/);
  assert.equal((xml.match(/table:content-validation-name="val7"/g) || []).length, 4, 'named on each cell of its range');
  assert.deepEqual(show(await sheetFromOds(buf)), want);
});

test('.xlsx: a custom formula rule keeps whether it refuses and its message', async () => {
  assert.deepEqual(show(await sheetFromExcel(await excelFromSheet(sheet))), want);
});

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
test('through LibreOffice: rules in our .ods and .xlsx, saved again by it in either format, come back the same', { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-odsrules-'));
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as}`))); };
  try {
    fs.writeFileSync(path.join(dir, 's.ods'), await odsFromSheet(sheet));
    fs.writeFileSync(path.join(dir, 's.xlsx'), await excelFromSheet(sheet));
    assert.deepEqual(show(await sheetFromOds(lo('s.ods', 'ods', 'a'))), want, '.ods saved again as .ods');
    assert.deepEqual(show(await sheetFromExcel(lo('s.ods', 'xlsx', 'b'))), want, '.ods saved as .xlsx');
    assert.deepEqual(show(await sheetFromOds(lo('s.xlsx', 'ods', 'c'))), want, '.xlsx saved as .ods');
    assert.deepEqual(show(await sheetFromExcel(lo('s.xlsx', 'xlsx', 'e'))), want, '.xlsx saved again as .xlsx');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
