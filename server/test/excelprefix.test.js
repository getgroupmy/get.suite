// Functions Excel added after 2007 are stored in .xlsx files as _xlfn.NAME(…); written plainly, Excel shows #NAME?.
// Every one of them that Sheets can work out must be written with it (and read back without it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { formulaToExcel, formulaFromExcel, excelFromSheet } from '../src/office/excel.js';
import { FUNCTION_NAMES } from '../src/sheetcalc/formula.js';

// Excel's own list of these (the "_xlfn." functions in its file format documentation), less the array ones written by ARRAY_FUNCS.
const XLFN = `ACOT ACOTH AGGREGATE ARABIC BASE BETA.DIST BETA.INV BINOM.DIST BINOM.DIST.RANGE BINOM.INV BITAND BITLSHIFT BITOR BITRSHIFT BITXOR
CEILING.MATH CEILING.PRECISE CHISQ.DIST CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT CHISQ.TEST COMBINA CONCAT CONFIDENCE.NORM CONFIDENCE.T COT COTH
COVARIANCE.P COVARIANCE.S CSC CSCH DAYS DECIMAL ECMA.CEILING ERF.PRECISE ERFC.PRECISE EXPON.DIST F.DIST F.DIST.RT F.INV F.INV.RT F.TEST FLOOR.MATH
FLOOR.PRECISE FORMULATEXT GAMMA GAMMA.DIST GAMMA.INV GAMMALN.PRECISE GAUSS HYPGEOM.DIST IFNA IFS ISFORMULA ISOWEEKNUM LOGNORM.DIST LOGNORM.INV
MAXIFS MINIFS MODE.MULT MODE.SNGL MUNIT NEGBINOM.DIST NETWORKDAYS.INTL NORM.DIST NORM.INV NORM.S.DIST NORM.S.INV NUMBERVALUE PDURATION
PERCENTILE.EXC PERCENTILE.INC PERCENTRANK.EXC PERCENTRANK.INC PERMUTATIONA PHI POISSON.DIST QUARTILE.EXC QUARTILE.INC RANK.AVG RANK.EQ RRI SEC
SECH SHEET SHEETS SKEW.P STDEV.P STDEV.S SWITCH T.DIST T.DIST.2T T.DIST.RT T.INV T.INV.2T T.TEST TEXTJOIN UNICHAR UNICODE VAR.P VAR.S
WEIBULL.DIST WORKDAY.INTL XOR Z.TEST XLOOKUP XMATCH VALUETOTEXT ARRAYTOTEXT REGEXTEST PERCENTOF`.split(/\s+/);

test('every one Sheets has is written with _xlfn., and read back plainly', () => {
  const ours = new Set(FUNCTION_NAMES);
  const missing = XLFN.filter((n) => ours.has(n) && formulaToExcel(`${n}(1)`) !== `_xlfn.${n}(1)`);
  assert.deepEqual(missing, [], `written without _xlfn.: ${missing.join(' ')}`);
  for (const n of XLFN.filter((x) => ours.has(x))) assert.equal(formulaFromExcel(`_xlfn.${n}(1)`), `${n}(1)`);
});

test('not inside text, and not part of a longer name', () => {
  assert.equal(formulaToExcel('"XOR(1)"&GAMMA.DIST(1,2,3,TRUE)+GAMMA(5)'), '"XOR(1)"&_xlfn.GAMMA.DIST(1,2,3,TRUE)+_xlfn.GAMMA(5)');
  assert.equal(formulaToExcel('CEILING(1)+SUM(A1)'), 'CEILING(1)+SUM(A1)', 'old functions stay plain');
});

test('a downloaded .xlsx has them so', async () => {
  const buf = await excelFromSheet({ sheets: [{ name: 'Sheet1', cells: { A1: '5', A2: '=AGGREGATE(9,6,A1)', A3: '=F.DIST.RT(1,2,3)' } }] });
  const xml = await (await JSZip.loadAsync(buf)).file('xl/worksheets/sheet1.xml').async('string');
  assert.match(xml, /<f>_xlfn\.AGGREGATE\(9,6,A1\)<\/f>/);
  assert.match(xml, /<f>_xlfn\.F\.DIST\.RT\(1,2,3\)<\/f>/);
});

test('a function given by its name (GROUPBY(…, SUM)) is _xleta.SUM in the file, and read back plainly', () => {
  assert.equal(formulaToExcel('GROUPBY(A2:A9, C2:C9, SUM, 3, 0)'), '_xlfn.GROUPBY(A2:A9, C2:C9, _xleta.SUM, 3, 0)');
  assert.equal(formulaToExcel('BYROW(A1:C3,STDEV.S)'), '_xlfn.BYROW(A1:C3,_xleta.STDEV.S)');
  assert.equal(formulaToExcel('SUM(A1:A3)+MAX(1,2)&"(SUM)"'), 'SUM(A1:A3)+MAX(1,2)&"(SUM)"', 'called functions and text stay as they are');
  assert.equal(formulaFromExcel('_xlfn.GROUPBY(A2:A9,C2:C9,_xleta.SUM)'), 'GROUPBY(A2:A9,C2:C9,SUM)');
});
