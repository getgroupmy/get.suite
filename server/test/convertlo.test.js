// CONVERT between 180 units in 13 kinds (mass, distance, time, pressure, force, energy, power, magnetism, temperature,
// volume, area, speed, information), 360 random calls (now and then across kinds, which is #N/A), worked out again by
// LibreOffice. The comparison found Pica and pica swapped (Excel's Pica is the point, 1/72 inch; pica 1/6 inch), and
// units Sheets didn't know: parsec (pc), the US and UK hundredweights (cwt, uk_cwt), the register and measurement tons
// (GRT, MTON), and the squared and cubed angstrom, light year, nautical mile and picas (ang2, ly3, Nmi2, Pica3…).
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excelFromSheet } from '../src/office/excel.js';
import { bookEvaluator } from '../src/sheetcalc/formula.js';

// LibreOffice's constants are older than Excel's in places (a few in a million); answers equal to 2 parts in 100,000
// count. Not compared: the light year (LibreOffice's is 9.46053E+15 m, Excel's 9.46073047258E+15), the admiralty knot
// (Excel's 6080 feet an hour) and the foot-pound (LibreOffice's flb isn't 1.3558 J).
const NOT_COMPARED = /"(ly|ly2|ly3|admkn|flb)"/;

test('CONVERT: the same answers as LibreOffice', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const GROUPS = [
    ['g', 'kg', 'lbm', 'ozm', 'stone', 'ton', 'u', 'grain', 'cwt', 'uk_cwt', 'uk_ton', 'sg', 'mg'],
    ['m', 'km', 'mi', 'Nmi', 'in', 'ft', 'yd', 'ang', 'ell', 'ly', 'parsec', 'pc', 'Pica', 'pica', 'survey_mi', 'cm', 'mm', 'um'],
    ['yr', 'day', 'd', 'hr', 'mn', 'min', 'sec', 's', 'ms'],
    ['Pa', 'atm', 'at', 'mmHg', 'psi', 'Torr', 'kPa', 'bar'],
    ['N', 'dyn', 'dy', 'lbf', 'pond'],
    ['J', 'e', 'c', 'cal', 'eV', 'ev', 'HPh', 'hh', 'Wh', 'wh', 'flb', 'BTU', 'btu', 'kWh'],
    ['HP', 'h', 'PS', 'W', 'w', 'kW'],
    ['T', 'ga'],
    ['C', 'cel', 'F', 'fah', 'K', 'kel', 'Rank', 'Reau'],
    ['tsp', 'tspm', 'tbs', 'oz', 'cup', 'pt', 'us_pt', 'uk_pt', 'qt', 'uk_qt', 'gal', 'uk_gal', 'l', 'L', 'lt', 'ang3', 'barrel', 'bushel', 'ft3', 'in3', 'ly3', 'm3', 'mi3', 'yd3', 'Nmi3', 'Pica3', 'GRT', 'regton', 'MTON', 'ml', 'mL', 'cm3'],
    ['uk_acre', 'us_acre', 'ang2', 'ar', 'ft2', 'ha', 'in2', 'ly2', 'm2', 'Morgen', 'mi2', 'Nmi2', 'Pica2', 'yd2', 'km2'],
    ['mph', 'kn', 'admkn', 'm/s', 'm/h', 'm/hr'],
    ['bit', 'byte', 'kbyte', 'Kibyte', 'Mibyte', 'kbit', 'Gbit'],
  ];
  let seed = 23; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const cells = {}, cases = [];
  let r = 0;
  for (let k = 0; k < 360; k++) {
    const g = pick(GROUPS), x = pick(['1', '2.5', '-40', '100', '0', '1000']);
    const a = pick(g), b = rnd() < 0.08 ? pick(pick(GROUPS)) : pick(g);
    r++; cells[`H${r}`] = `=CONVERT(${x},"${a}","${b}")`; cases.push(cells[`H${r}`]);
  }
  const book = { sheets: [{ name: 'S', cells }] };
  const ev = bookEvaluator(book.sheets, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convertlo-'));
  fs.mkdirSync(path.join(dir, 'profile', 'user'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile', 'user', 'registrymodifications.xcu'), `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>`);
  fs.writeFileSync(path.join(dir, 'b.xlsx'), await excelFromSheet(book));
  soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):9,0,76,1,,1033,false,true,false', '--outdir', dir, path.join(dir, 'b.xlsx')]);
  const lines = fs.readFileSync(path.join(dir, 'b.csv'), 'utf8').replace(/\r/g, '').split('\n');
  fs.rmSync(dir, { recursive: true, force: true });
  const same = (a, b) => a === b || (/^Err:5/.test(b) && /^#/.test(a)) || (a !== '' && b !== '' && Number.isFinite(+a) && Number.isFinite(+b) && Math.abs(+a - +b) <= 2e-5 * Math.abs(+b));
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
  assert.ok(compared > 320, `compared ${compared}`);
  assert.deepEqual(wrong, []);
});

test('the fixed cases', () => {
  const cells = {
    A1: '=CONVERT(1,"in","Pica")', A2: '=CONVERT(1,"in","pica")', A3: '=CONVERT(1,"uk_ton","uk_cwt")', A4: '=CONVERT(1,"GRT","ft3")',
    A5: '=CONVERT(1,"Nmi2","m2")', A6: '=ROUND(CONVERT(1,"pc","ly"),4)', A7: '=CONVERT(1,"cwt","lbm")', A8: '=CONVERT(1E+20,"ang2","m2")',
  };
  const ev = bookEvaluator([{ name: 'S', cells }], 0);
  assert.deepEqual(Object.keys(cells).map((k) => ev(k)), [72, 6, 20, 100, 3429904, 3.2616, 100, 1]);
});
