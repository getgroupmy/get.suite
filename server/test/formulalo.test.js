// The formula engine against LibreOffice: about 170 formulas over a small table (maths, statistics, lookups, text,
// logic, dates, finance, distributions, conversions, arithmetic on text and booleans) written to an .xlsx, worked out
// again by LibreOffice (a profile set to recalculate on load, so it doesn't just read our results back) and compared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { excelFromSheet } from '../src/office/excel.js';
import { bookEvaluator } from '../src/sheetcalc/formula.js';

const DATA = { B1: '10', B2: '20', B3: '30', B4: '40', B5: 'x', C1: 'Apple', C2: 'banana', C3: 'Cherry', C4: 'apple', C5: '', D1: '2026-01-15', D2: '2026-03-01', D3: '2026-11-20', E1: '0.1', E2: '-0.2', E3: '0.3' };
const FX = `ABS(-3.5)|ROUND(2.675,2)|ROUND(-2.5,0)|ROUNDUP(-1.1,0)|ROUNDDOWN(1.99,1)|MROUND(7.5,5)|CEILING(2.1,0.5)|FLOOR(2.9,0.5)|INT(-1.5)|TRUNC(-1.57,1)|MOD(-3,2)|MOD(3,-2)|QUOTIENT(-7,2)|POWER(2,0.5)|SQRT(16)|EXP(1)|LN(10)|LOG(8,2)|LOG10(1000)|FACT(5)|COMBIN(10,3)|PERMUT(10,3)|GCD(24,36)|LCM(4,6)|SIGN(-2)|PI()|EVEN(3)|ODD(2)|SUMSQ(1,2,3)|PRODUCT(B1:B3)|SUM(B1:B5)|AVERAGE(B1:B4)|MEDIAN(B1:B4)|MODE(1,2,2,3)|MAX(B1:B5)|MIN(B1:B4)|COUNT(B1:B5)|COUNTA(B1:B5)|COUNTBLANK(C1:C5)|STDEV(B1:B4)|STDEVP(B1:B4)|VAR(B1:B4)|VARP(B1:B4)|LARGE(B1:B4,2)|SMALL(B1:B4,2)|RANK(30,B1:B4)|PERCENTILE(B1:B4,0.3)|QUARTILE(B1:B4,1)|CORREL(B1:B4,{1;3;2;5})|SLOPE(B1:B4,{1;3;2;5})|INTERCEPT(B1:B4,{1;3;2;5})|FORECAST(4,B1:B4,{1;3;2;5})|GEOMEAN(B1:B4)|HARMEAN(B1:B4)|AVEDEV(B1:B4)|DEVSQ(B1:B4)|SKEW(1,2,3,9)|KURT(1,2,3,9,4)|SUMIF(B1:B4,">15")|SUMIF(C1:C4,"apple",B1:B4)|COUNTIF(C1:C4,"a*")|COUNTIFS(B1:B4,">10",C1:C4,"<>banana")|AVERAGEIF(B1:B4,"<35")|SUMPRODUCT(B1:B4,B1:B4)|VLOOKUP("cherry",C1:E3,3,FALSE)|HLOOKUP(20,B1:B4,1,FALSE)|INDEX(B1:B4,3)|MATCH(25,B1:B4,1)|MATCH("banana",C1:C4,0)|LOOKUP(25,B1:B4)|CHOOSE(2,"a","b","c")|LEN(C2)|LEFT(C1,3)|RIGHT(C1,2)|MID(C1,2,3)|UPPER(C2)|LOWER(C1)|PROPER("hello WORLD")|TRIM("  a   b ")|SUBSTITUTE("a-b-c","-","+")|SUBSTITUTE("a-b-c","-","+",2)|REPLACE("abcdef",2,3,"X")|FIND("b","abcb",3)|SEARCH("B","abcb")|REPT("ab",3)|CONCATENATE("a","b",1)|EXACT("a","A")|CHAR(65)|CODE("a")|TEXT(1234.567,"#,##0.00")|TEXT(0.256,"0.0%")|TEXT(45000,"yyyy-mm-dd")|FIXED(1234.567,1)|DOLLAR(1234.5)|VALUE("12.5")|T("x")|N(TRUE)|CLEAN("a"&CHAR(7)&"b")|IF(B1>5,"y","n")|IFERROR(1/0,"e")|AND(TRUE,B1>5)|OR(FALSE,B1>50)|NOT(TRUE)|XOR(TRUE,TRUE)|ISNUMBER(B5)|ISTEXT(B5)|ISBLANK(C5)|ISERROR(1/0)|ISEVEN(4)|ISODD(4)|YEAR(D3)|MONTH(D3)|DAY(D3)|WEEKDAY(D3)|WEEKDAY(D3,2)|WEEKNUM(D3)|ISOWEEKNUM(D3)|DATE(2026,2,30)|EDATE(D1,1)|EOMONTH(D1,1)|DAYS(D3,D1)|DATEDIF(D1,D3,"m")|DATEDIF(D1,D3,"md")|NETWORKDAYS(D1,D2)|WORKDAY(D1,10)|YEARFRAC(D1,D3)|YEARFRAC(D1,D3,1)|DAYS360(D1,D3)|HOUR(0.75)|MINUTE(0.7525)|TIME(14,30,0)|PMT(0.05/12,360,200000)|FV(0.06/12,120,-100)|PV(0.08/12,240,-500)|NPER(0.01,-100,1000)|RATE(48,-200,8000)|IPMT(0.1/12,1,36,8000)|PPMT(0.1/12,1,24,2000)|NPV(0.1,B1:B4)|IRR({-100,30,40,50})|SLN(30000,7500,10)|SYD(30000,7500,10,1)|DDB(2400,300,10,1)|EFFECT(0.0525,4)|NORMDIST(42,40,1.5,TRUE)|NORMSINV(0.975)|TDIST(1.96,60,2)|CHIDIST(18.307,10)|BINOMDIST(6,10,0.5,FALSE)|POISSON(2,5,TRUE)|EXPONDIST(0.2,10,TRUE)|DEC2BIN(9)|HEX2DEC("FF")|BIN2DEC("1001")|ROMAN(1994)|ARABIC("MCMXCIV")|BASE(255,16)|SUM(E1:E3)|E1+E3=0.4|0.1+0.2=0.3|"10"+5|TRUE+1|"a"&1.5|1E+21&""|2^-1|-2^2|10%`.split('|');

const soffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();
test('formulas give LibreOffice\'s answers', { skip: !soffice && 'LibreOffice isn’t installed here' }, async () => {
  const cells = { ...DATA };
  FX.forEach((f, i) => { cells[`H${i + 1}`] = `=${f}`; });
  const book = { sheets: [{ name: 'S', cells }] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxlo-'));
  fs.mkdirSync(path.join(dir, 'profile', 'user'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile', 'user', 'registrymodifications.xcu'), `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>`);
  fs.writeFileSync(path.join(dir, 'b.xlsx'), await excelFromSheet(book));
  execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):44,34,76,1,,1033,false,true,false', '--outdir', dir, path.join(dir, 'b.xlsx')], { stdio: 'ignore', timeout: 120000 });
  const parse = (line) => { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  const lo = fs.readFileSync(path.join(dir, 'b.csv'), 'utf8').replace(/\r/g, '').split('\n').map((l) => parse(l)[7] ?? '');
  // LibreOffice shows some results in a format of its own even so: 0.77% and 02:30:00 PM, back as numbers
  const asNumber = (s) => {
    const pct = /^(-?[\d.]+(?:E[-+]?\d+)?)%$/.exec(s); if (pct) return Number(pct[1]) / 100;
    const t = /^(\d{2}):(\d{2}):(\d{2}) ([AP])M$/.exec(s); if (t) return (((Number(t[1]) % 12) + (t[4] === 'P' ? 12 : 0)) * 3600 + Number(t[2]) * 60 + Number(t[3])) / 86400;
    return s !== '' && !Number.isNaN(Number(s)) ? Number(s) : null;
  };
  const ev = bookEvaluator(book.sheets, 0);
  const diffs = [];
  FX.forEach((f, i) => {
    let o = ev(`H${i + 1}`);
    if (o && typeof o === 'object') o = o.error;
    if (typeof o === 'boolean') o = o ? 'TRUE' : 'FALSE';
    const l = lo[i] ?? '', ln = asNumber(l), on = typeof o === 'number' ? o : asNumber(String(o ?? ''));
    if (on !== null && ln !== null && Math.abs(on - ln) <= 1e-6 * Math.max(1, Math.abs(ln))) return;
    if (String(o ?? '') === l) return;
    diffs.push(`${f}: ours ${JSON.stringify(o)}, LibreOffice ${JSON.stringify(l)}`);
  });
  assert.deepEqual(diffs, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
