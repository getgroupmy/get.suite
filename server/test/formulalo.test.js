// The formula engine against LibreOffice: about 170 formulas over a small table (maths, statistics, lookups, text,
// logic, dates, finance, distributions, conversions, arithmetic on text and booleans) written to an .xlsx, worked out
// again by LibreOffice (a profile set to recalculate on load, so it doesn't just read our results back) and compared.
import { soffice, hasSoffice } from './soffice.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { excelFromSheet } from '../src/office/excel.js';
import { bookEvaluator } from '../src/sheetcalc/formula.js';

const DATA = { B1: '10', B2: '20', B3: '30', B4: '40', B5: 'x', C1: 'Apple', C2: 'banana', C3: 'Cherry', C4: 'apple', C5: '', D1: '2026-01-15', D2: '2026-03-01', D3: '2026-11-20', E1: '0.1', E2: '-0.2', E3: '0.3' };
const FX = `ABS(-3.5)|ROUND(2.675,2)|ROUND(-2.5,0)|ROUNDUP(-1.1,0)|ROUNDDOWN(1.99,1)|MROUND(7.5,5)|CEILING(2.1,0.5)|FLOOR(2.9,0.5)|INT(-1.5)|TRUNC(-1.57,1)|MOD(-3,2)|MOD(3,-2)|QUOTIENT(-7,2)|POWER(2,0.5)|SQRT(16)|EXP(1)|LN(10)|LOG(8,2)|LOG10(1000)|FACT(5)|COMBIN(10,3)|PERMUT(10,3)|GCD(24,36)|LCM(4,6)|SIGN(-2)|PI()|EVEN(3)|ODD(2)|SUMSQ(1,2,3)|PRODUCT(B1:B3)|SUM(B1:B5)|AVERAGE(B1:B4)|MEDIAN(B1:B4)|MODE(1,2,2,3)|MAX(B1:B5)|MIN(B1:B4)|COUNT(B1:B5)|COUNTA(B1:B5)|COUNTBLANK(C1:C5)|STDEV(B1:B4)|STDEVP(B1:B4)|VAR(B1:B4)|VARP(B1:B4)|LARGE(B1:B4,2)|SMALL(B1:B4,2)|RANK(30,B1:B4)|PERCENTILE(B1:B4,0.3)|QUARTILE(B1:B4,1)|CORREL(B1:B4,{1;3;2;5})|SLOPE(B1:B4,{1;3;2;5})|INTERCEPT(B1:B4,{1;3;2;5})|FORECAST(4,B1:B4,{1;3;2;5})|GEOMEAN(B1:B4)|HARMEAN(B1:B4)|AVEDEV(B1:B4)|DEVSQ(B1:B4)|SKEW(1,2,3,9)|KURT(1,2,3,9,4)|SUMIF(B1:B4,">15")|SUMIF(C1:C4,"apple",B1:B4)|COUNTIF(C1:C4,"a*")|COUNTIFS(B1:B4,">10",C1:C4,"<>banana")|AVERAGEIF(B1:B4,"<35")|SUMPRODUCT(B1:B4,B1:B4)|VLOOKUP("cherry",C1:E3,3,FALSE)|HLOOKUP(20,B1:B4,1,FALSE)|INDEX(B1:B4,3)|MATCH(25,B1:B4,1)|MATCH("banana",C1:C4,0)|LOOKUP(25,B1:B4)|CHOOSE(2,"a","b","c")|LEN(C2)|LEFT(C1,3)|RIGHT(C1,2)|MID(C1,2,3)|UPPER(C2)|LOWER(C1)|PROPER("hello WORLD")|TRIM("  a   b ")|SUBSTITUTE("a-b-c","-","+")|SUBSTITUTE("a-b-c","-","+",2)|REPLACE("abcdef",2,3,"X")|FIND("b","abcb",3)|SEARCH("B","abcb")|REPT("ab",3)|CONCATENATE("a","b",1)|EXACT("a","A")|CHAR(65)|CODE("a")|TEXT(1234.567,"#,##0.00")|TEXT(0.256,"0.0%")|TEXT(45000,"yyyy-mm-dd")|FIXED(1234.567,1)|DOLLAR(1234.5)|VALUE("12.5")|T("x")|N(TRUE)|CLEAN("a"&CHAR(7)&"b")|IF(B1>5,"y","n")|IFERROR(1/0,"e")|AND(TRUE,B1>5)|OR(FALSE,B1>50)|NOT(TRUE)|XOR(TRUE,TRUE)|ISNUMBER(B5)|ISTEXT(B5)|ISBLANK(C5)|ISERROR(1/0)|ISEVEN(4)|ISODD(4)|YEAR(D3)|MONTH(D3)|DAY(D3)|WEEKDAY(D3)|WEEKDAY(D3,2)|WEEKNUM(D3)|ISOWEEKNUM(D3)|DATE(2026,2,30)|EDATE(D1,1)|EOMONTH(D1,1)|DAYS(D3,D1)|DATEDIF(D1,D3,"m")|DATEDIF(D1,D3,"md")|NETWORKDAYS(D1,D2)|WORKDAY(D1,10)|YEARFRAC(D1,D3)|YEARFRAC(D1,D3,1)|DAYS360(D1,D3)|HOUR(0.75)|MINUTE(0.7525)|TIME(14,30,0)|PMT(0.05/12,360,200000)|FV(0.06/12,120,-100)|PV(0.08/12,240,-500)|NPER(0.01,-100,1000)|RATE(48,-200,8000)|IPMT(0.1/12,1,36,8000)|PPMT(0.1/12,1,24,2000)|NPV(0.1,B1:B4)|IRR({-100,30,40,50})|SLN(30000,7500,10)|SYD(30000,7500,10,1)|DDB(2400,300,10,1)|EFFECT(0.0525,4)|NORMDIST(42,40,1.5,TRUE)|NORMSINV(0.975)|TDIST(1.96,60,2)|CHIDIST(18.307,10)|BINOMDIST(6,10,0.5,FALSE)|POISSON(2,5,TRUE)|EXPONDIST(0.2,10,TRUE)|DEC2BIN(9)|HEX2DEC("FF")|BIN2DEC("1001")|ROMAN(1994)|ARABIC("MCMXCIV")|BASE(255,16)|SUM(E1:E3)|E1+E3=0.4|0.1+0.2=0.3|"10"+5|TRUE+1|"a"&1.5|1E+21&""|2^-1|-2^2|10%`.split('|');

/** What LibreOffice works out for column H of a book's first sheet: written as .xlsx, recalculated on load, read as CSV. */
async function libreOfficeResults(book) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxlo-'));
  fs.mkdirSync(path.join(dir, 'profile', 'user'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile', 'user', 'registrymodifications.xcu'), `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>`);
  fs.writeFileSync(path.join(dir, 'b.xlsx'), await excelFromSheet(book));
  soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):44,34,76,1,,1033,false,true,false', '--outdir', dir, path.join(dir, 'b.xlsx')]);
  const parse = (line) => { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  const out = fs.readFileSync(path.join(dir, 'b.csv'), 'utf8').replace(/\r/g, '').split('\n').map((l) => parse(l)[7] ?? '');
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
// LibreOffice shows some results in a format of its own even so: 0.77% and 02:30:00 PM, back as numbers
const asNumber = (s) => {
  const pct = /^(-?[\d.]+(?:E[-+]?\d+)?)%$/.exec(s); if (pct) return Number(pct[1]) / 100;
  const t = /^(\d{2}):(\d{2}):(\d{2}) ([AP])M$/.exec(s); if (t) return (((Number(t[1]) % 12) + (t[4] === 'P' ? 12 : 0)) * 3600 + Number(t[2]) * 60 + Number(t[3])) / 86400;
  return s !== '' && !Number.isNaN(Number(s)) ? Number(s) : null;
};
/** How our answer differs from LibreOffice's (null when the same). */
function differs(value, l) {
  let o = value;
  if (o && typeof o === 'object') o = o.error;
  if (typeof o === 'boolean') o = o ? 'TRUE' : 'FALSE';
  const ln = asNumber(l), on = typeof o === 'number' ? o : asNumber(String(o ?? ''));
  if (on !== null && ln !== null && Math.abs(on - ln) <= 1e-6 * Math.max(1, Math.abs(ln))) return null;
  if (String(o ?? '') === l) return null;
  return `ours ${JSON.stringify(o)}, LibreOffice ${JSON.stringify(l)}`;
}

test('formulas give LibreOffice\'s answers', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const book = { sheets: [{ name: 'S', cells: { ...DATA, ...Object.fromEntries(FX.map((f, i) => [`H${i + 1}`, `=${f}`])) } }] };
  const lo = await libreOfficeResults(book);
  const ev = bookEvaluator(book.sheets, 0);
  const diffs = FX.map((f, i) => { const d = differs(ev(`H${i + 1}`), lo[i] ?? ''); return d && `${f}: ${d}`; }).filter(Boolean);
  assert.deepEqual(diffs, []);
});

// A second set: newer functions LibreOffice 24.2 has (TEXTJOIN, IFS, SWITCH, MAXIFS…) and edge cases (accents and emoji in
// text, month ends and leap days, errors, text and TRUE among numbers, approximate lookups). Where Excel and LibreOffice
// differ, Excel's answer is checked instead (EXCEL_NOT_LO, with why).
const DATA2 = { B1: '10', B2: '20', B3: '', B4: 'TRUE', B5: 'x', B6: '-5', C1: 'Ägypten', C2: 'élan', C3: 'Zoë', C4: '😀ab', C5: 'a,b,,c', D1: '2024-02-29', D2: '2023-12-31', D3: '2025-01-01', E1: '1', E2: '3', E3: '5', E4: '7' };
const FX2 = `TEXTJOIN("-",TRUE,C1:C3)|TEXTJOIN(",",FALSE,B1:B3)|CONCAT(B1:B2,"z")|IFS(B1>15,"a",B1>5,"b")|SWITCH(B2,10,"ten",20,"twenty","other")|MAXIFS(B1:B2,B1:B2,">5")|MINIFS(B1:B6,B1:B6,"<15")|LEN(C1)|UPPER(C2)|LOWER(C1)|LEN(C4)|LEFT(C4,2)|MID(C3,3,1)|FIND("ë",C3)|SUBSTITUTE(C5,",",";")|TRIM(CHAR(9)&"a  b")|PROPER("o'neil mcdonald")|PROPER("hello-world 2nd")|LEFT("abc",0)|RIGHT("abc",5)|MID("abc",5,2)|REPT("x",0)|EDATE(D1,12)|EOMONTH(D1,0)|EDATE(D1,-1)|DATE(2024,1,0)|DATE(2024,0,15)|DATE(2024,14,1)|DAYS360(D1,D3)|DAYS360(D1,D3,TRUE)|WEEKNUM(D2,2)|ISOWEEKNUM(D2)|ISOWEEKNUM(D3)|WEEKDAY(D1,3)|NETWORKDAYS(D2,D3)|WORKDAY(D2,1)|YEARFRAC(D2,D1,3)|DATEDIF(D2,D3,"yd")|SUM(B1:B6)|AVERAGE(B1:B6)|AVERAGEA(B1:B6)|COUNT(B1:B6)|COUNTA(B1:B6)|MAXA(B1:B6)|MINA(B1:B6)|SUMPRODUCT((B1:B2>5)*B1:B2)|SUMPRODUCT(--(E1:E4>2))|SUM(E1:E4*E1:E4)|MAX(ABS(B6),B1)|IFERROR(VLOOKUP(99,E1:E4,1,FALSE),"none")|VLOOKUP(4,E1:E4,1,TRUE)|VLOOKUP(0,E1:E4,1,TRUE)|MATCH(8,E1:E4,1)|MATCH(4,E1:E4,-1)|INDEX(E1:E4,0,1)*0+INDEX(E1:E4,2)|ISNA(MATCH(99,E1:E4,0))|ERROR.TYPE(1/0)|ERROR.TYPE(NA())|IFNA(NA(),"n")|ISERR(NA())|ISERROR(B5+1)|N("5")|T(5)|VALUE("1e3")|VALUE(" 12 ")|"3"*"4"|"a"="A"|"a"<"b"|"B">"a"|1<"a"|TRUE>1|FALSE<0|LEN(1/3)|ROUND(1E+15+0.4,0)|INT(1E+300)|10/3|-0|SQRT(-1)|LN(0)|0^0|POWER(0,-1)|FACT(171)|MOD(10,0)|MOD(5.5,2)|MOD(-5.5,2)|TRUNC(1E-20)|ROUND(123.456,-2)|ROUNDUP(0.0001,2)|FLOOR(-2.5,-1)|CEILING(-2.5,-1)|MROUND(-7,-2)|COMBIN(0,0)|STDEV(E1:E4)|VAR(E1:E1)|LARGE(E1:E4,5)|PERCENTRANK(E1:E4,4)|RANK(5,E1:E4,1)|MEDIAN(E1:E4,100)|NORMSDIST(0)|NORMINV(0.5,10,2)|TINV(0.05,10)|CHIINV(0.05,3)|FDIST(2,3,10)|BINOMDIST(3,5,0.5,TRUE)|HYPGEOMDIST(1,4,8,20)|WEIBULL(1,2,3,TRUE)|LOGNORMDIST(4,1.5,0.5)|GAMMADIST(2,3,1,TRUE)|BETADIST(0.5,2,3)|ROMAN(3999)|DEC2HEX(-1)|HEX2DEC("FFFFFFFFFF")|DEC2BIN(-1)|BIN2DEC("1111111111")|CONVERT(1,"mi","km")|CONVERT(100,"C","F")|DELTA(2,2)|GESTEP(-1)|FIXED(-1234.5,0,TRUE)|DOLLAR(-1.005,2)|TEXT(-0.5,"0%")|TEXT(1,"0.0E+00")|TEXT(0,"#")|TEXT(1234,"0,000.0")|CLEAN(CHAR(31)&"a")|CODE("€")|UNICODE("€")|UNICHAR(8364)|EXACT("Zoë","zoë")|SEARCH("?b",C4)|SEARCH("~*","a*b")|COUNTIF(C1:C3,"*ë*")|COUNTIF(E1:E4,"<>3")|COUNTIF(E1:E4,">=3")|SUMIF(E1:E4,"<5",E1:E4)|AVERAGEIFS(E1:E4,E1:E4,">1",E1:E4,"<7")|COUNTIFS(E1:E4,">1",E1:E4,"<7")`.split('|');
const EXCEL_NOT_LO = new Map([
  ['LEN(C4)', [4, '😀 counts as 2, as in Excel (LibreOffice: 1)']],
  ['LEFT(C4,2)', ['😀', 'Excel counts 😀 as 2']],
  ['SEARCH("?b",C4)', [3, 'Excel counts 😀 as 2']],
  ['SUM(B1:B6)', [25, 'TRUE in a cell isn\'t added, as in Excel (LibreOffice: 1)']],
  ['AVERAGE(B1:B6)', [25 / 3, 'TRUE in a cell isn\'t counted, as in Excel']],
  ['COUNT(B1:B6)', [3, 'TRUE in a cell isn\'t counted, as in Excel']],
  ['SUM(E1:E4*E1:E4)', [84, 'arrays work in any formula, as in Excel 365 (LibreOffice 24.2: #VALUE! outside an array formula)']],
  ['INDEX(E1:E4,0,1)*0+INDEX(E1:E4,2)', [{ error: '#SPILL!' }, 'a column result where it has no room, as in Excel 365']],
  ['TRUE>1', [true, 'TRUE ranks above numbers, as in Excel (LibreOffice: TRUE is 1)']],
  ['SQRT(-1)', [{ error: '#NUM!' }, 'LibreOffice: Err:502, the same error by its own name']],
  ['LN(0)', [{ error: '#NUM!' }, 'LibreOffice: Err:502']],
  ['FACT(171)', [{ error: '#NUM!' }, 'Excel: #NUM! (LibreOffice: #VALUE!)']],
  ['LARGE(E1:E4,5)', [{ error: '#NUM!' }, 'Excel: #NUM! (LibreOffice: #VALUE!)']],
  ['DOLLAR(-1.005,2)', ['($1.01)', 'Excel rounds the number as written and puts a negative in brackets (LibreOffice: -$1.00)']],
  ['CODE("€")', [8364, 'its Unicode number, as Google Sheets (Excel: the system code page; LibreOffice: 63)']],
]);
test('more formulas give LibreOffice\'s answers (or Excel\'s, where the two differ)', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const book = { sheets: [{ name: 'S', cells: { ...DATA2, ...Object.fromEntries(FX2.map((f, i) => [`H${i + 1}`, `=${f}`])) } }] };
  const lo = await libreOfficeResults(book);
  const ev = bookEvaluator(book.sheets, 0);
  const diffs = [];
  FX2.forEach((f, i) => {
    const o = ev(`H${i + 1}`);
    if (EXCEL_NOT_LO.has(f)) { const [want, why] = EXCEL_NOT_LO.get(f); if (JSON.stringify(typeof want === 'number' && typeof o === 'number' ? Number(o.toFixed(9)) : o) !== JSON.stringify(typeof want === 'number' ? Number(want.toFixed(9)) : want)) diffs.push(`${f}: ${JSON.stringify(o)} (${why})`); return; }
    const d = differs(o, lo[i] ?? '');
    if (d) diffs.push(`${f}: ${d}`);
  });
  assert.deepEqual(diffs, []);
});
