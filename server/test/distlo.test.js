// Probability distributions and their inverses (normal, t, chi-squared, F, binomial, Poisson, gamma, beta, lognormal,
// exponential, Weibull, hypergeometric, negative binomial) with edge arguments (probability 0 and 1, df 0.5 and 1000, x of
// 0 and -1), 38 functions 8 times each at random, worked out again by LibreOffice. The comparison found F.INV and
// GAMMA.INV of probability 0 (and F.INV.RT of 1) giving a solver's 2.8E-13 instead of 0, BINOM.INV refusing alpha 0 and
// p 0, and NEGBINOM.DIST refusing a chance of 0 (Excel allows each).
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excelFromSheet } from '../src/office/excel.js';
import { bookEvaluator } from '../src/sheetcalc/formula.js';

// Where Excel and LibreOffice part ways, Sheets does as Excel: F.INV(0, …) is 0 (LibreOffice refuses it),
// LOGNORM.DIST(0, …) is #NUM! (Excel wants x above 0), and POISSON.DIST with a mean of 0 is 1 at 0 and 0 elsewhere
// (LibreOffice refuses it). Any error matches any (LibreOffice's #VALUE! for Excel's #NUM! at NORM.INV(0)).
const NOT_COMPARED = /^=F\.INV\(0,|^=LOGNORM\.DIST\(0,|^=POISSON\.DIST\([^,]+,0,/;

test('distributions with edge arguments: the same answers as LibreOffice', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  let seed = 41; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const x = () => pick(['0', '0.5', '1', '2.5', '-1', '10', '0.001', '30', '3']);
  const p = () => pick(['0', '0.01', '0.05', '0.5', '0.95', '0.999', '1', '-0.1', '1.1']);
  const k = () => pick(['0', '1', '2', '5', '10', '2.7', '-1', '20']);
  const df = () => pick(['1', '2', '5', '30', '0', '0.5', '2.5', '1000']);
  const tf = () => pick(['TRUE', 'FALSE']);
  const T = [
    () => `=NORM.DIST(${x()},${pick(['0', '1', '-1'])},${pick(['1', '2', '0', '-1'])},${tf()})`, () => `=NORM.INV(${p()},${pick(['0', '5'])},${pick(['1', '2', '0'])})`, () => `=NORM.S.DIST(${x()},${tf()})`, () => `=NORM.S.INV(${p()})`,
    () => `=T.DIST(${x()},${df()},${tf()})`, () => `=T.DIST.2T(${x()},${df()})`, () => `=T.DIST.RT(${x()},${df()})`, () => `=T.INV(${p()},${df()})`, () => `=T.INV.2T(${p()},${df()})`,
    () => `=CHISQ.DIST(${x()},${df()},${tf()})`, () => `=CHISQ.DIST.RT(${x()},${df()})`, () => `=CHISQ.INV(${p()},${df()})`, () => `=CHISQ.INV.RT(${p()},${df()})`,
    () => `=F.DIST(${x()},${df()},${df()},${tf()})`, () => `=F.DIST.RT(${x()},${df()},${df()})`, () => `=F.INV(${p()},${df()},${df()})`, () => `=F.INV.RT(${p()},${df()},${df()})`,
    () => `=BINOM.DIST(${k()},${pick(['10', '5', '0', '20'])},${p()},${tf()})`, () => `=BINOM.INV(${pick(['10', '5', '0'])},${p()},${p()})`, () => `=POISSON.DIST(${k()},${x()},${tf()})`,
    () => `=GAMMA.DIST(${x()},${df()},${df()},${tf()})`, () => `=GAMMA.INV(${p()},${df()},${df()})`, () => `=BETA.DIST(${p()},${df()},${df()},${tf()})`, () => `=BETA.INV(${p()},${df()},${df()})`,
    () => `=LOGNORM.DIST(${x()},${pick(['0', '1'])},${pick(['1', '0.5', '0'])},${tf()})`, () => `=LOGNORM.INV(${p()},0,1)`, () => `=EXPON.DIST(${x()},${df()},${tf()})`, () => `=WEIBULL.DIST(${x()},${df()},${df()},${tf()})`,
    () => `=HYPGEOM.DIST(${k()},${pick(['4', '10', '0'])},${pick(['8', '5', '20'])},20,${tf()})`, () => `=NEGBINOM.DIST(${k()},${pick(['3', '1', '0'])},${p()},${tf()})`, () => `=GAMMA(${x()})`, () => `=GAMMALN(${x()})`,
    () => `=CONFIDENCE.NORM(${p()},${pick(['1', '2', '0'])},${pick(['10', '1', '0'])})`, () => `=CONFIDENCE.T(${p()},2,${pick(['10', '1', '2'])})`, () => `=PHI(${x()})`, () => `=GAUSS(${x()})`, () => `=FISHER(${p()})`, () => `=FISHERINV(${x()})`,
  ];
  const cells = {}, cases = [];
  let r = 0;
  for (const t of T) for (let n = 0; n < 8; n++) { r++; cells[`H${r}`] = t(); cases.push(cells[`H${r}`]); }
  const book = { sheets: [{ name: 'S', cells }] };
  const ev = bookEvaluator(book.sheets, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'distlo-'));
  fs.mkdirSync(path.join(dir, 'profile', 'user'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile', 'user', 'registrymodifications.xcu'), `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>`);
  fs.writeFileSync(path.join(dir, 'b.xlsx'), await excelFromSheet(book));
  soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):9,0,76,1,,1033,false,true,false', '--outdir', dir, path.join(dir, 'b.xlsx')]);
  const lines = fs.readFileSync(path.join(dir, 'b.csv'), 'utf8').replace(/\r/g, '').split('\n');
  fs.rmSync(dir, { recursive: true, force: true });
  // (numbers equal to 7 significant places, as iterative inverses settle; tiny tails within 1E-14)
  const same = (a, b) => a === b || (/^#|^Err:/.test(a) && /^#|^Err:/.test(b))
    || (a !== '' && b !== '' && Number.isFinite(+a) && Number.isFinite(+b) && (Math.abs(+a - +b) <= 1e-7 * Math.abs(+b) || Math.abs(+a - +b) < 1e-14));
  const wrong = [];
  let compared = 0;
  cases.forEach((c, i) => {
    if (NOT_COMPARED.test(c)) return;
    let ours = ev(`H${i + 1}`);
    ours = String(ours?.error ?? ours);
    const lo = lines[i].split('\t').pop();
    compared++;
    if (!same(ours, lo)) wrong.push(`${c}: ${ours}, LibreOffice ${lo}`);
  });
  assert.ok(compared > 280, `compared ${compared}`);
  assert.deepEqual(wrong, []);
});

test('the fixed cases', () => {
  const cells = {
    A1: '=F.INV(0,5,10)', A2: '=F.INV.RT(1,5,10)', A3: '=GAMMA.INV(0,5,2)', A4: '=BINOM.INV(10,0.5,0)', A5: '=BINOM.INV(10,0,0.5)',
    A6: '=NEGBINOM.DIST(3,2,0,FALSE)', A7: '=CHISQ.INV(0,3)', A8: '=BINOM.INV(0,0.5,0.5)',
  };
  const ev = bookEvaluator([{ name: 'S', cells }], 0);
  assert.deepEqual(Object.keys(cells).map((k) => ev(k)), [0, 0, 0, 0, 0, 0, 0, 0]);
});
