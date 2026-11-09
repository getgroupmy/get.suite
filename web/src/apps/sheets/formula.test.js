import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluator, colName, colIndex, shiftFormula, display, bookEvaluator, importFileId, safeLink } from './formula.js';

const ev = (cells) => createEvaluator(cells);

test('column names', () => {
  assert.equal(colName(0), 'A');
  assert.equal(colName(25), 'Z');
  assert.equal(colName(26), 'AA');
  assert.equal(colName(701), 'ZZ');
  assert.equal(colIndex('AA'), 26);
});

test('arithmetic and precedence', () => {
  const g = ev({ A1: '=1+2*3', A2: '=(1+2)*3', A3: '=2^3^1', A4: '=-2^2', A5: '=50%', A6: '=10/4' });
  assert.equal(g('A1'), 7);
  assert.equal(g('A2'), 9);
  assert.equal(g('A3'), 8);
  assert.equal(g('A4'), 4);
  assert.equal(g('A5'), 0.5);
  assert.equal(g('A6'), 2.5);
});

test('references, ranges and functions', () => {
  const g = ev({ A1: '1', A2: '2', A3: '3', A4: 'text', B1: '=SUM(A1:A4)', B2: '=AVERAGE(A1:A3)', B3: '=A1+A2*A3',
    B4: '=MAX(A1:A3, 10)', B5: '=COUNT(A1:A4)', B6: '=COUNTA(A1:A4)', B7: '=IF(A1>0, "pos", "neg")',
    B8: '=CONCAT(A4, "-", A1)', B9: '=A4&"!"', C1: '=SUMIF(A1:A3, ">1")', C2: '=COUNTIF(A1:A4, "text")',
    C3: '=ROUND(2/3, 2)', C4: '=MEDIAN(A1:A3, 4)', C5: '=empty+1', C6: '=E99*2' });
  assert.equal(g('B1'), 6);
  assert.equal(g('B2'), 2);
  assert.equal(g('B3'), 7);
  assert.equal(g('B4'), 10);
  assert.equal(g('B5'), 3);
  assert.equal(g('B6'), 4);
  assert.equal(g('B7'), 'pos');
  assert.equal(g('B8'), 'text-1');
  assert.equal(g('B9'), 'text!');
  assert.equal(g('C1'), 5);
  assert.equal(g('C2'), 1);
  assert.equal(g('C3'), 0.67);
  assert.equal(g('C4'), 2.5);
  assert.deepEqual(g('C5'), { error: '#NAME?' });
  assert.equal(g('C6'), 0, 'empty cells count as 0');
});

test('errors propagate and cycles are detected', () => {
  const g = ev({ A1: '=1/0', A2: '=A1+1', B1: '=B2', B2: '=B1', C1: '="a"*2', D1: '=IFERROR(1/0, "x")', E1: '=SUM(', E2: '=FOO(1)' });
  assert.deepEqual(g('A1'), { error: '#DIV/0!' });
  assert.deepEqual(g('A2'), { error: '#DIV/0!' });
  assert.deepEqual(g('B1'), { error: '#CIRC!' });
  assert.deepEqual(g('C1'), { error: '#VALUE!' });
  assert.equal(g('D1'), 'x');
  assert.deepEqual(g('E1'), { error: '#ERROR!' });
  assert.deepEqual(g('E2'), { error: '#NAME?' });
});

test('IF short-circuits', () => {
  const g = ev({ A1: '=IF(TRUE, 1, 1/0)' });
  assert.equal(g('A1'), 1);
});

test('shifting references', () => {
  assert.equal(shiftFormula('=A1+$B$2+B$3+"A1"', 1, 2), '=B3+$B$2+C$3+"A1"');
  assert.equal(shiftFormula('=SUM(A1:A3)', 0, 1), '=SUM(A2:A4)');
  assert.equal(shiftFormula('=A1', -1, 0), '=#REF!');
});

test('display', () => {
  assert.equal(display(0.1 + 0.2), '0.3');
  assert.equal(display(true), 'TRUE');
  assert.equal(display({ error: '#REF!' }), '#REF!');
});

test('lookups: VLOOKUP, HLOOKUP, INDEX and MATCH', () => {
  const cells = { A1: 'Name', B1: 'Score', A2: 'bob', B2: '7', A3: 'Amy', B3: '10', A4: 'cat', B4: '3', E1: '10', F1: '20', G1: '30', E2: 'low', F2: 'mid', G2: 'high' };
  const v = (f) => createEvaluator({ ...cells, Z1: f })('Z1');
  assert.equal(v('=VLOOKUP("amy",A2:B4,2,FALSE)'), 10);
  assert.deepEqual(v('=VLOOKUP("zed",A2:B4,2,FALSE)'), { error: '#N/A' });
  assert.deepEqual(v('=VLOOKUP("bob",A2:B4,3,FALSE)'), { error: '#REF!' });
  assert.equal(v('=HLOOKUP(25,E1:G2,2)'), 'mid'); // approximate: the last value not over 25
  assert.equal(v('=HLOOKUP(5,E1:G2,2,TRUE)').error, '#N/A');
  assert.equal(v('=INDEX(A2:B4,3,2)'), 3);
  assert.equal(v('=INDEX(E2:G2,2)'), 'mid'); // one row: the number picks the column
  assert.equal(v('=INDEX(A2:B4,MATCH("c*",A2:A4,0),2)'), 3);
  assert.equal(v('=MATCH(20,E1:G1)'), 2);
  assert.equal(v('=MATCH(25,E1:G1,1)'), 2);
  assert.equal(v('=IFNA(MATCH("zed",A2:A4,0),"none")'), 'none');
});

test('conditions over ranges', () => {
  const cells = { A1: 'east', A2: 'west', A3: 'east', A4: 'north', B1: '10', B2: '20', B3: '30', B4: '' };
  const v = (f) => createEvaluator({ ...cells, Z1: f })('Z1');
  assert.equal(v('=SUMIFS(B1:B4,A1:A4,"east",B1:B4,">15")'), 30);
  assert.equal(v('=COUNTIFS(A1:A4,"*st",B1:B4,"<25")'), 2);
  assert.equal(v('=AVERAGEIF(A1:A4,"east",B1:B4)'), 20);
  assert.equal(v('=AVERAGEIFS(B1:B4,A1:A4,"<>west")'), 20);
  assert.equal(v('=MAXIFS(B1:B4,A1:A4,"east")'), 30);
  assert.equal(v('=MINIFS(B1:B4,A1:A4,"east")'), 10);
  assert.equal(v('=COUNTIF(A1:A4,"?ast")'), 2);
  assert.equal(v('=COUNTIF(A1:A4,"~*")'), 0);
  assert.equal(v('=COUNTBLANK(B1:B4)'), 1);
  assert.equal(v('=PRODUCT(B1:B3)'), 6000);
  assert.equal(v('=LARGE(B1:B4,2)'), 20);
  assert.equal(v('=SMALL(B1:B4,1)'), 10);
  assert.deepEqual(v('=SUMIFS(B1:B4,A1:A3,"east")'), { error: '#VALUE!' }); // ranges of different sizes
});

test('numbers, text and dates', () => {
  const v = (f) => createEvaluator({ Z1: f })('Z1');
  assert.equal(v('=ROUNDUP(2.1,0)'), 3);
  assert.equal(v('=ROUNDDOWN(-2.9,0)'), -2);
  assert.equal(v('=ROUNDUP(1.005,2)'), 1.01);
  assert.equal(v('=CEILING(7,5)'), 10);
  assert.equal(v('=FLOOR(7,5)'), 5);
  assert.equal(v('=MID("spreadsheet",7,5)'), 'sheet');
  assert.equal(v('=SUBSTITUTE("a-b-c","-","+")'), 'a+b+c');
  assert.equal(v('=SUBSTITUTE("a-b-c","-","+",2)'), 'a-b+c');
  assert.equal(v('=FIND("b","abcb",3)'), 4);
  assert.deepEqual(v('=FIND("B","abc")'), { error: '#VALUE!' }); // case matters for FIND
  assert.equal(v('=SEARCH("B?","abcb")'), 2);
  assert.equal(v('=VALUE("1,234.5")'), 1234.5);
  assert.equal(v('=PROPER("hello wORLD")'), 'Hello World');
  assert.equal(v('=REPT("ab",3)'), 'ababab');
  assert.equal(v('=EXACT("a","A")'), false);
  assert.equal(v('=TEXTJOIN(", ",TRUE,"a","","b")'), 'a, b');
  assert.equal(v('=ISNUMBER(3)&ISTEXT("x")&ISBLANK(A9)'), 'TRUETRUETRUE');
  assert.equal(v('=ISERROR(1/0)'), true);
  assert.equal(v('=IFS(1>2,"a",2>1,"b")'), 'b');
  assert.equal(v('=SWITCH("b","a",1,"b",2,0)'), 2);
  assert.equal(v('=SWITCH("z","a",1,0)'), 0);
  assert.equal(v('=DATE(2026,2,30)'), '2026-03-02');
  assert.equal(v('=YEAR("2026-11-06")*100+MONTH("2026-11-06")'), 202611);
  assert.equal(v('=DAY(46000)'), 9); // a spreadsheet serial number: 9 December 2025
  assert.equal(v('=WEEKDAY("2026-11-06")'), 6); // Friday
  assert.equal(v('=WEEKDAY("2026-11-06",2)'), 5);
  assert.equal(v('=DAYS("2026-12-25","2026-11-06")'), 49);
  assert.equal(v('=EDATE("2026-01-31",1)'), '2026-02-28');
  assert.equal(v('=EOMONTH("2026-02-10",0)'), '2026-02-28');
  assert.deepEqual(v('=NA()'), { error: '#N/A' });
});

test('XLOOKUP: exact, not found, nearest, wildcards, last match, whole rows and across', () => {
  const g = ev({ A1: 'apple', A2: 'pear', A3: 'plum', A4: 'pear', B1: '10', B2: '20', B3: '30', B4: '40', C1: 'red', C2: 'green', C3: 'purple', C4: 'yellow',
    D1: '=XLOOKUP("pear", A1:A4, B1:B4)', D2: '=XLOOKUP("kiwi", A1:A4, B1:B4)', D3: '=XLOOKUP("kiwi", A1:A4, B1:B4, "none")',
    D4: '=XLOOKUP("pear", A1:A4, B1:B4, , 0, -1)', D5: '=XLOOKUP("pl*", A1:A4, C1:C4, , 2)', D6: '=XLOOKUP(25, B1:B4, A1:A4, , -1)',
    D7: '=XLOOKUP(25, B1:B4, A1:A4, , 1)', D8: '=INDEX(XLOOKUP("plum", A1:A4, B1:C4), 1, 2)', D9: '=XLOOKUP(20, B1:B3, A1:A4)',
    E1: 'x', F1: 'y', G1: 'z', E2: '1', F2: '2', G2: '3', E3: '=XLOOKUP("y", E1:G1, E2:G2)' });
  assert.equal(g('D1'), 20);
  assert.deepEqual(g('D2'), { error: '#N/A' });
  assert.equal(g('D3'), 'none');
  assert.equal(g('D4'), 40);
  assert.equal(g('D5'), 'purple');
  assert.equal(g('D6'), 'pear');
  assert.equal(g('D7'), 'plum');
  assert.equal(g('D8'), 'purple');
  assert.deepEqual(g('D9'), { error: '#VALUE!' });
  assert.equal(g('E3'), 2);
});

test('statistics: STDEV, VAR, RANK and SUMPRODUCT', () => {
  const g = ev({ A1: '2', A2: '4', A3: '4', A4: '4', A5: '5', A6: '5', A7: '7', A8: '9', B1: '3', B2: '1',
    C1: '=STDEV.P(A1:A8)', C2: '=VAR.P(A1:A8)', C3: '=ROUND(STDEV(A1:A8), 4)', C4: '=ROUND(VAR.S(A1:A8), 4)', C5: '=STDEV(A1)',
    C6: '=RANK(5, A1:A8)', C7: '=RANK.EQ(5, A1:A8, 1)', C8: '=RANK(6, A1:A8)', C9: '=SUMPRODUCT(A1:A2, B1:B2)', C10: '=SUMPRODUCT(A1:A3, B1:B2)' });
  assert.equal(g('C1'), 2);
  assert.equal(g('C2'), 4);
  assert.equal(g('C3'), 2.1381);
  assert.equal(g('C4'), 4.5714);
  assert.deepEqual(g('C5'), { error: '#DIV/0!' });
  assert.equal(g('C6'), 3);
  assert.equal(g('C7'), 5);
  assert.deepEqual(g('C8'), { error: '#N/A' });
  assert.equal(g('C9'), 10);
  assert.deepEqual(g('C10'), { error: '#VALUE!' });
});

test('TEXT formats numbers and dates', () => {
  const g = ev({ A1: '1234.567', A2: '0.256', A3: '-5', A4: '2026-11-07',
    B1: '=TEXT(A1, "#,##0.00")', B2: '=TEXT(A1, "0")', B3: '=TEXT(A2, "0%")', B4: '=TEXT(A2, "0.0%")', B5: '=TEXT(A3, "$0.00")',
    B6: '=TEXT(7, "000")', B7: '=TEXT(A4, "dd/mm/yyyy")', B8: '=TEXT(A4, "dddd d mmmm yyyy")', B9: '=TEXT(A4, "mmm yy")', B10: '=TEXT(A1, "0.##")', B11: '=TEXT(2, "0.##")' });
  assert.equal(g('B1'), '1,234.57');
  assert.equal(g('B2'), '1235');
  assert.equal(g('B3'), '26%');
  assert.equal(g('B4'), '25.6%');
  assert.equal(g('B5'), '-$5.00');
  assert.equal(g('B6'), '007');
  assert.equal(g('B7'), '07/11/2026');
  assert.equal(g('B8'), 'Saturday 7 November 2026');
  assert.equal(g('B9'), 'Nov 26');
  assert.equal(g('B10'), '1234.57');
  assert.equal(g('B11'), '2');
});

test('working days and DATEDIF', () => {
  const g = ev({ H1: '2026-11-11',
    A1: '=NETWORKDAYS("2026-11-02", "2026-11-13")', A2: '=NETWORKDAYS("2026-11-02", "2026-11-13", H1)', A3: '=NETWORKDAYS("2026-11-13", "2026-11-02")',
    A4: '=WORKDAY("2026-11-06", 1)', A5: '=WORKDAY("2026-11-09", -1)', A6: '=WORKDAY("2026-11-10", 1, H1:H1)',
    B1: '=DATEDIF("2020-03-15", "2026-11-07", "Y")', B2: '=DATEDIF("2020-03-15", "2026-11-07", "M")', B3: '=DATEDIF("2020-03-15", "2026-11-07", "YM")',
    B4: '=DATEDIF("2020-03-15", "2026-11-07", "MD")', B5: '=DATEDIF("2026-11-01", "2026-11-07", "D")', B6: '=DATEDIF("2026-11-07", "2026-11-01", "D")', B7: '=DATEDIF("2026-03-15", "2026-11-07", "YD")' });
  assert.equal(g('A1'), 10);
  assert.equal(g('A2'), 9);
  assert.equal(g('A3'), -10);
  assert.equal(g('A4'), '2026-11-09');
  assert.equal(g('A5'), '2026-11-06');
  assert.equal(g('A6'), '2026-11-12');
  assert.equal(g('B1'), 6);
  assert.equal(g('B2'), 79);
  assert.equal(g('B3'), 7);
  assert.equal(g('B4'), 23);
  assert.equal(g('B5'), 6);
  assert.deepEqual(g('B6'), { error: '#NUM!' });
  assert.equal(g('B7'), 237);
});

test('loans, logs and other maths', () => {
  const g = ev({ A1: '=ROUND(PMT(0.05/12, 360, 200000), 2)', A2: '=PMT(0, 10, 1000)', A3: '=ROUND(FV(0.06/12, 10, -200, -500, 1), 2)', A4: '=ROUND(PV(0.08/12, 240, 500), 2)',
    B1: '=LOG(1000)', B2: '=LOG(8, 2)', B3: '=LN(EXP(2))', B4: '=TRUNC(-4.78)', B5: '=TRUNC(3.14159, 2)', B6: '=ISODD(3)', B7: '=ISEVEN(-4)', B8: '=LN(0)',
    C1: '=CHAR(65)', C2: '=CODE("a")', C3: '=RANDBETWEEN(3, 3)', C4: '=LOG10(100)' });
  assert.equal(g('A1'), -1073.64);
  assert.equal(g('A2'), -100);
  assert.equal(g('A3'), 2581.4);
  assert.equal(g('A4'), -59777.15);
  assert.equal(g('B1'), 3);
  assert.equal(g('B2'), 3);
  assert.equal(g('B3'), 2);
  assert.equal(g('B4'), -4);
  assert.equal(g('B5'), 3.14);
  assert.equal(g('B6'), true);
  assert.equal(g('B7'), true);
  assert.deepEqual(g('B8'), { error: '#NUM!' });
  assert.equal(g('C1'), 'A');
  assert.equal(g('C2'), 97);
  assert.equal(g('C3'), 3);
  assert.equal(g('C4'), 2);
});

test('IMPORTRANGE: cells and ranges of another spreadsheet, by link or id, with its own formulas', () => {
  const other = { sheets: [{ name: 'Sheet1', cells: { A1: '5', A2: '7', A3: '=A1*2' } }, { name: 'Prices 2026', cells: { A1: 'Tea', B1: '3.5', A2: 'Cake', B2: '=Data!A1', }, }, { name: 'Data', cells: { A1: '4' } }] };
  const asked = [];
  const imports = { book: (id) => { asked.push(id); return id === 'abc123' ? other : id === 'secret1' ? { error: 'not found' } : null; }, depth: 0 };
  const ev = bookEvaluator([{ name: 'S', cells: {
    A1: '=IMPORTRANGE("abc123", "A3")',
    A2: '=SUM(IMPORTRANGE("https://ws.example.com/sheets/abc123", "Sheet1!A1:A3"))',
    A3: `=VLOOKUP("cake", IMPORTRANGE("abc123", "'Prices 2026'!A1:B2"), 2, FALSE)`,
    A4: '=IMPORTRANGE("secret1", "A1")',
    A5: '=IMPORTRANGE("waiting9", "A1")',
    A6: '=IMPORTRANGE("abc123", "Nope!A1")',
    A7: '=IMPORTRANGE("abc123", "rubbish")',
    A8: '=IFERROR(IMPORTRANGE("waiting9", "A1"), "…")',
  } }], 0, imports);
  assert.equal(ev('A1'), 10);
  assert.equal(ev('A2'), 22);
  assert.equal(ev('A3'), 4);
  assert.deepEqual(ev('A4'), { error: '#REF!' });
  assert.deepEqual(ev('A5'), { error: '#LOADING' });
  assert.deepEqual(ev('A6'), { error: '#REF!' });
  assert.deepEqual(ev('A7'), { error: '#REF!' });
  assert.equal(ev('A8'), '…');
  assert.ok(asked.includes('waiting9'));
  // Without a way to load other files (a version preview), it's #REF!.
  assert.deepEqual(bookEvaluator([{ name: 'S', cells: { A1: '=IMPORTRANGE("abc123", "A1")' } }], 0)('A1'), { error: '#REF!' });
  assert.equal(importFileId('http://nas:8080/sheets/f_9x-Y?x=1'), 'f_9x-Y');
  assert.equal(importFileId('no good'), null);
});

test('IMPORTRANGE: spreadsheets importing each other stop after a few steps', () => {
  const books = { aaaaaa: { sheets: [{ name: 'A', cells: { A1: '=IMPORTRANGE("bbbbbb", "A1")' } }] }, bbbbbb: { sheets: [{ name: 'B', cells: { A1: '=IMPORTRANGE("aaaaaa", "A1")' } }] } };
  const ev = bookEvaluator(books.aaaaaa.sheets, 0, { book: (id) => books[id], depth: 0 });
  assert.deepEqual(ev('A1'), { error: '#REF!' });
});

test('spilling: a formula giving several cells fills the empty cells beside and below it', () => {
  const v = ev({
    A1: '=SEQUENCE(3)', B1: '=A1:A3*10', C1: '=SUM(B1:B3)',
    E1: '=SEQUENCE(2, 3, 5, 5)',
    A6: 'x', A5: '=SEQUENCE(3)',
    H1: '=TRANSPOSE(A1:A3)',
  });
  assert.deepEqual([v('A1'), v('A2'), v('A3'), v('A4')], [1, 2, 3, null]);
  assert.deepEqual([v('B1'), v('B2'), v('B3')], [10, 20, 30]);
  assert.equal(v('C1'), 60, 'a formula can use spilled cells');
  assert.deepEqual([v('E1'), v('F1'), v('G1'), v('E2'), v('G2')], [5, 10, 15, 20, 30]);
  assert.deepEqual(v('A5'), { error: '#SPILL!' }, 'blocked by A6');
  assert.deepEqual([v('H1'), v('I1'), v('J1')], [1, 2, 3]);
  assert.equal(v.spilledFrom('A2'), 'A1');
  assert.equal(v.spilledFrom('A1'), null);
  // A formula asked about first, before the cells it reads were filled, still sees them.
  const w = ev({ D1: '=SUM(A1:A4)', A1: '=SEQUENCE(4)' });
  assert.equal(w('D1'), 10);
});

test('FILTER, UNIQUE and SORT', () => {
  const v = ev({
    A1: 'Tea', B1: '3', A2: 'Cake', B2: '12', A3: 'tea', B3: '8', A4: 'Pie', B4: '15',
    D1: '=FILTER(A1:B4, B1:B4>5)',
    G1: '=UNIQUE(A1:A4)',
    I1: '=SORT(A1:B4, 2, -1)',
    L1: '=FILTER(A1:A4, B1:B4>100)', L2: '=FILTER(A1:A4, B1:B4>100, "none")',
    M1: '=SUM(FILTER(B1:B4, A1:A4="tea"))',
    N1: '=COUNTA(UNIQUE(A1:A4))',
  });
  assert.deepEqual([v('D1'), v('E1'), v('D2'), v('E2'), v('D3'), v('E3'), v('D4')], ['Cake', 12, 'tea', 8, 'Pie', 15, null]);
  assert.deepEqual([v('G1'), v('G2'), v('G3'), v('G4')], ['Tea', 'Cake', 'Pie', null], 'any case counts as the same');
  assert.deepEqual([v('I1'), v('J1'), v('I4'), v('J4')], ['Pie', 15, 'Tea', 3]);
  assert.deepEqual(v('L1'), { error: '#CALC!' });
  assert.equal(v('L2'), 'none');
  assert.equal(v('M1'), 11);
  assert.equal(v('N1'), 3);
});

test('HYPERLINK: a label that opens a web address (or an email); nothing else', () => {
  const v = ev({ A1: '=HYPERLINK("https://acme.com/orders", "Orders")', A2: '=HYPERLINK("acme.com")', A3: '=HYPERLINK("javascript:alert(1)", "x")', A4: '=HYPERLINK("kim@acme.com", "Email Kim")', B1: 'https://x.example', A5: '=HYPERLINK(B1, B1 & " site")' });
  assert.equal(v('A1'), 'Orders'); assert.equal(v.linkOf('A1'), 'https://acme.com/orders');
  assert.equal(v('A2'), 'https://acme.com/'); assert.equal(v.linkOf('A2'), 'https://acme.com/');
  assert.deepEqual(v('A3'), { error: '#VALUE!' }); assert.equal(v.linkOf('A3'), null);
  assert.equal(v.linkOf('A4'), 'mailto:kim@acme.com');
  assert.equal(v('A5'), 'https://x.example site');
  assert.equal(v.linkOf('B1'), null, 'plain text is just text');
});

test('SPARKLINE: the numbers of a range as a line or columns in the cell', () => {
  const v = ev({ A1: '3', A2: '5', A3: 'n/a', A4: '2', B1: '=SPARKLINE(A1:A4)', B2: '=SPARKLINE(A1:A4, "column")', B3: '=SPARKLINE(C1:C3)' });
  assert.equal(v('B1'), '');
  assert.deepEqual(v.sparkOf('B1'), { type: 'line', values: [3, 5, null, 2] });
  assert.equal(v.sparkOf('B2').type, 'column');
  assert.deepEqual(v('B3'), { error: '#VALUE!' });
});

test('more functions: patterns, splitting, choosing, stacking, times, week numbers, cash flows, where cells are', () => {
  const v = (f, cells = {}) => { const e = createEvaluator({ F1: -100, F2: 30, F3: 40, F4: 50, G1: 'apple', G2: 'Banana', G3: 'apple', G4: '', ...cells, Z1: f }); try { const r = e('Z1'); return r && typeof r === 'object' && r.error ? r.error : r; } catch (x) { return x.code; } };
  assert.equal(v('=REGEXMATCH("Invoice INV-2041", "INV-\\d+")'), true);
  assert.equal(v('=REGEXMATCH("hello", "^\\d+$")'), false);
  assert.equal(v('=REGEXEXTRACT("Order 1234 shipped", "\\d+")'), '1234');
  assert.equal(v('=REGEXEXTRACT("Kim <kim@acme.com>", "<(.+)>")'), 'kim@acme.com');
  assert.equal(v('=REGEXEXTRACT("abc", "\\d")'), '#N/A');
  assert.equal(v('=REGEXREPLACE("2026-11-08", "(\\d+)-(\\d+)-(\\d+)", "$3/$2/$1")'), '08/11/2026');
  assert.equal(v('=REGEXMATCH("x", "(")'), '#VALUE!', 'a broken pattern');
  // SPLIT spills across; numbers stay numbers.
  const sp = createEvaluator({ A1: '=SPLIT("red, green,,7", ", ")' });
  assert.deepEqual(['A1', 'B1', 'C1', 'D1'].map((k) => sp(k)), ['red', 'green', 7, null]);
  const sp2 = createEvaluator({ A1: '=SPLIT("a--b--c", "--", FALSE)' });
  assert.deepEqual(['A1', 'B1', 'C1'].map((k) => sp2(k)), ['a', 'b', 'c']);
  assert.equal(v('=JOIN("-", 1, 2, 3)'), '1-2-3');
  assert.equal(v('=COUNTUNIQUE(G1:G4)'), 2, 'any case, blanks left out');
  assert.equal(v('=FIXED(1234.567, 1)'), '1,234.6');
  assert.equal(v('=CHOOSE(2, "low", "mid", "high")'), 'mid');
  assert.equal(v('=CHOOSE(4, "a", "b")'), '#VALUE!');
  assert.equal(v('=XMATCH("banana", G1:G3)'), 2);
  assert.equal(v('=XMATCH("apple", G1:G3, 0, -1)'), 3, 'searching from the end');
  assert.equal(v('=XMATCH(35, F2:F4, -1)'), 1, 'exact or next smaller');
  assert.equal(v('=XMATCH(35, F2:F4, 1)'), 2, 'exact or next larger');
  assert.equal(v('=XMATCH("b*", G1:G3, 2)'), 2, 'wildcards');
  // Stacking and taking.
  const st = createEvaluator({ F1: 1, F2: 2, G1: 3, A1: '=VSTACK(F1:F2, G1)', C1: '=HSTACK(F1:F2, G1)' });
  assert.deepEqual(['A1', 'A2', 'A3', 'C1', 'D1', 'C2', 'D2'].map((k) => st(k)), [1, 2, 3, 1, 3, 2, '#N/A']);
  const tk = createEvaluator({ F1: 1, F2: 2, F3: 3, F4: 4, A1: '=TAKE(F1:F4, 2)', B1: '=TAKE(F1:F4, -1)', C1: '=DROP(F1:F4, 3)' });
  assert.deepEqual(['A1', 'A2', 'A3', 'B1', 'C1', 'C2'].map((k) => tk(k)), [1, 2, null, 4, 4, null]);
  // Times of day.
  assert.equal(v('=TIME(14, 30, 0)'), 14.5 / 24);
  assert.equal(v('=HOUR("2:45 PM")'), 14);
  assert.equal(v('=MINUTE("2026-11-08 09:07:30")'), 7);
  assert.equal(v('=SECOND(TIME(1, 2, 3))'), 3);
  assert.equal(v('=HOUR("25:00")'), '#VALUE!');
  // Week numbers: 2026-01-01 is a Thursday.
  assert.equal(v('=WEEKNUM("2026-01-03")'), 1);
  assert.equal(v('=WEEKNUM("2026-01-04")'), 2, 'a new week on Sunday');
  assert.equal(v('=WEEKNUM("2026-01-04", 2)'), 1, 'weeks from Monday');
  assert.equal(v('=ISOWEEKNUM("2026-01-01")'), 1);
  assert.equal(v('=ISOWEEKNUM("2027-01-01")'), 53, '2027-01-01 is a Friday in 2026’s week 53');
  assert.equal(v('=ISOWEEKNUM("2026-12-28")'), 53);
  // Cash flows.
  assert.equal(Math.round(v('=NPV(0.1, F2:F4)') * 100) / 100, 97.9);
  assert.equal(Math.round(v('=IRR(F1:F4)') * 1e4) / 1e4, 0.089);
  assert.equal(v('=IRR(F2:F4)'), '#NUM!', 'needs money out and in');
  assert.equal(Math.round(v('=RATE(12, -100, 1000)') * 1e5) / 1e5, 0.02923);
  assert.equal(Math.round(v('=NPER(0.01, -100, 1000)') * 100) / 100, 10.59);
  assert.equal(v('=NPER(0, -100, 1000)'), 10);
  // Where cells are.
  assert.equal(v('=ROW()'), 1);
  assert.equal(createEvaluator({ C7: '=ROW()&","&COLUMN()' })('C7'), '7,3');
  assert.equal(v('=ROW(B5:D9)'), 5);
  assert.equal(v('=COLUMN(D2)'), 4);
  assert.equal(v('=ROWS(F1:G4)&"x"&COLUMNS(F1:G4)'), '4x2');
});

test('more statistics: MODE, PERCENTILE, QUARTILE, CORREL, SLOPE, INTERCEPT, FORECAST, RSQ, GEOMEAN, AVERAGEA', () => {
  // Sales (B) against advertising (A): y = 2x + 1, except one point.
  const g0 = ev({
    A1: 1, A2: 2, A3: 3, A4: 4, A5: 5, B1: 3, B2: 5, B3: 7, B4: 9, B5: 12, B6: 'n/a',
    D1: 7, D2: 3, D3: 7, D4: 1, D5: 3, D6: 7,
    C1: '=MODE(D1:D6)', C2: '=MODE.SNGL(A1:A5)', C3: '=PERCENTILE(A1:A5, 0.25)', C4: '=PERCENTILE.INC(D1:D6, 0.9)',
    C5: '=QUARTILE(D1:D6, 2)', C6: '=QUARTILE.INC(A1:A5, 4)', C7: '=ROUND(CORREL(B1:B5, A1:A5), 4)', C8: '=ROUND(RSQ(B1:B5, A1:A5), 4)',
    C9: '=SLOPE(B1:B5, A1:A5)', C10: '=ROUND(INTERCEPT(B1:B5, A1:A5), 4)', C11: '=FORECAST(10, B1:B5, A1:A5)', C12: '=FORECAST.LINEAR(6, B1:B5, A1:A5)',
    C13: '=GEOMEAN(1, 4, 16)', C14: '=AVERAGEA(A1, TRUE, "x")', C15: '=PERCENTILE(A1:A5, 2)', C16: '=SLOPE(A1:A5, A1:A4)', C17: '=PEARSON(A1:A5, A1:A5)',
  });
  const g = (r) => { const v = g0(r); return v?.error ?? v; };
  assert.equal(g('C1'), 7);
  assert.equal(g('C2'), '#N/A', 'nothing repeats');
  assert.equal(g('C3'), 2);
  assert.equal(g('C4'), 7);
  assert.equal(g('C5'), 5);
  assert.equal(g('C6'), 5);
  assert.equal(g('C7'), 0.9959);
  assert.equal(g('C8'), 0.9918);
  assert.equal(g('C9'), 2.2);
  assert.equal(g('C10'), 0.6);
  assert.ok(Math.abs(g('C11') - 22.6) < 1e-9);
  assert.ok(Math.abs(g('C12') - 13.8) < 1e-9);
  assert.ok(Math.abs(g('C13') - 4) < 1e-9);
  assert.equal(g('C14'), 2 / 3, 'text counts as 0, TRUE as 1');
  assert.equal(g('C15'), '#NUM!');
  assert.equal(g('C16'), '#N/A', 'ranges of different sizes');
  assert.ok(Math.abs(g('C17') - 1) < 1e-12);
});

test('more maths: MROUND, QUOTIENT, GCD, LCM, FACT, COMBIN, EVEN, ODD, ROWS, COLUMNS', () => {
  const g0 = ev({
    A1: '=MROUND(10, 3)', A2: '=MROUND(0.15, 0.1)', A3: '=MROUND(-7, -2)', A4: '=MROUND(5, -2)', A5: '=QUOTIENT(-7, 2)', A6: '=QUOTIENT(1, 0)',
    A7: '=GCD(24, 36, 60)', A8: '=LCM(4, 6, 10)', A9: '=FACT(5)', A10: '=COMBIN(6, 2)', A11: '=COMBIN(2, 6)',
    A12: '=EVEN(1.2)', A13: '=EVEN(-3)', A14: '=ODD(2)', A15: '=ODD(0)', A16: '=ROWS(B1:D4)', A17: '=COLUMNS(B1:D4)', A18: '=FACT(-1)', A19: '=ROWS(B2)',
  });
  const g = (r) => { const v = g0(r); return v?.error ?? v; };
  assert.deepEqual(['A1', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18', 'A19'].map(g),
    [9, -8, '#NUM!', -3, '#DIV/0!', 12, 60, 120, 15, '#NUM!', 2, -4, 3, 1, 4, 3, '#NUM!', 1]);
  assert.ok(Math.abs(g('A2') - 0.2) < 1e-12);
});

test('LET and LAMBDA: names in a formula, and MAP, BYROW, BYCOL, REDUCE, SCAN, MAKEARRAY', () => {
  const g0 = createEvaluator({
    A1: 1, A2: 2, A3: 3, B1: 10, B2: 20, B3: 30, E1: 'Tax', E2: 0.1,
    C1: '=LET(net, SUM(B1:B3), tax, net*0.2, net+tax)',
    C2: '=LET(x, 2, y, x*10, LET(x, 5, x+y))', // the inner x hides the outer one
    C3: '=LET(rate, 0.5, rate*100) + Rate', // outside the LET, Rate is the named range again
    C4: '=REDUCE(0, A1:A3, LAMBDA(total, v, total + v*v))',
    C5: '=LAMBDA(x, x*2)',
    C6: '=LET(x, 1)',
    C7: '=MAP(A1:A3, B1:B3, LAMBDA(a, b, a))', // fills C7:C9
    D1: '=MAP(A1:A3, LAMBDA(v, IF(v>1, v*100, "small")))', // fills D1:D3
    F1: '=BYROW(A1:B3, LAMBDA(row, SUM(row)))', // F1:F3
    G1: '=BYCOL(A1:B3, LAMBDA(col, MAX(col)))', // G1:H1
    G2: '=SCAN(0, A1:A3, LAMBDA(acc, v, acc+v))', // G2:G4
    I1: '=MAKEARRAY(2, 3, LAMBDA(r, c, r*10+c))', // I1:K2
    I3: '=MAP(A1:A3, LAMBDA(a, b, a))', // a LAMBDA with the wrong number of names
    I4: '=LET(A1, 5, A1)', // a cell address can't be a name
    I5: '=LET(price, 4, qty, 3, MAP(A1:A1, LAMBDA(v, v + price*qty)))', // a LAMBDA sees the LET's names
  }, { Rate: 'E2' });
  const g = (r) => { const v = g0(r); return v?.error ?? v; };
  assert.equal(g('C1'), 72);
  assert.equal(g('C2'), 25);
  assert.equal(g('C3'), 50.1);
  assert.equal(g('C4'), 14);
  assert.equal(g('C5'), '#VALUE!');
  assert.equal(g('C6'), '#N/A');
  assert.deepEqual(['C7', 'C8', 'C9'].map(g), [1, 2, 3]);
  assert.deepEqual(['D1', 'D2', 'D3'].map(g), ['small', 200, 300]);
  assert.deepEqual(['F1', 'F2', 'F3'].map(g), [11, 22, 33]);
  assert.deepEqual(['G1', 'H1'].map(g), [3, 30]);
  assert.deepEqual(['G2', 'G3', 'G4'].map(g), [1, 3, 6]);
  assert.deepEqual(['I1', 'J1', 'K1', 'I2', 'J2', 'K2'].map(g), [11, 12, 13, 21, 22, 23]);
  assert.equal(g('I3'), '#VALUE!');
  assert.equal(g('I4'), '#NAME?');
  assert.equal(g('I5'), 13);
});

import { namedFunctions } from './formula.js';
test('named functions: defined once for the spreadsheet, used like any function, on every sheet', () => {
  const functions = [
    { name: 'WithTax', params: ['amount'], body: '=amount * (1 + Rate)', description: 'Adds sales tax' },
    { name: 'MARGIN', params: ['price', 'cost'], body: 'ROUND((price - cost) / price * 100, 1)' },
    { name: 'TOTALS', params: ['r'], body: 'BYROW(r, LAMBDA(row, SUM(row)))' },
    { name: 'FOREVER', params: ['x'], body: 'FOREVER(x)' },
    { name: 'SUM', params: ['x'], body: 'x' }, // a built-in's name: skipped
    { name: 'A1', params: [], body: '1' }, // looks like a cell: skipped
    { name: 'TWICE', params: ['x', 'X'], body: 'x' }, // the same argument twice: skipped
  ];
  assert.deepEqual([...namedFunctions(functions).keys()], ['WITHTAX', 'MARGIN', 'TOTALS', 'FOREVER']);
  const sheets = [
    { name: 'Prices', cells: { A1: 100, B1: 60, A2: 50, B2: 45, C1: '=withtax(A1)', C2: '=MARGIN(A1, B1)', C3: '=MARGIN(A1)', C4: '=FOREVER(1)', C5: '=TOTALS(A1:B2)', C7: '=TWICE(1)', D1: '=LET(amount, 7, WITHTAX(A2) + amount)' }, names: { Rate: 'E1' } },
    { name: 'Other', cells: { A1: '=WITHTAX(10)', A2: '=MARGIN(Prices!A2, Prices!B2)' } },
  ];
  sheets[0].cells.E1 = 0.2;
  const ev = bookEvaluator(sheets, 0, null, functions);
  const g = (k) => { const v = ev(k); return v?.error ?? v; };
  assert.equal(g('C1'), 120);
  assert.equal(g('C2'), 40);
  assert.equal(g('C3'), '#N/A', 'too few arguments');
  assert.equal(g('C4'), '#REF!', 'calls itself for ever');
  assert.deepEqual([g('C5'), g('C6')], [160, 95]);
  assert.equal(g('C7'), '#NAME?');
  assert.equal(g('D1'), 67, 'its own names don\'t leak in or out');
  const other = bookEvaluator(sheets, 1, null, functions);
  assert.equal(other('A1')?.error ?? other('A1'), '#NAME?', 'Rate is a name on Prices only');
  assert.equal(other('A2'), 10);
  assert.equal(bookEvaluator(sheets, 0)('C1')?.error, '#NAME?', 'without them: unknown');
});

test('IMAGE: a Drive picture in the cell, fitted, stretched, its own size or a set size', async () => {
  const { pictureId, imageFormula } = await import('./formula.js');
  const v = ev({ A1: 'drive:pic123', B1: '=IMAGE("drive:pic123")', B2: '=IMAGE(A1, 2)', B3: '=IMAGE("drive:pic123", 4, 80, 120)', B4: '=IMAGE("https://example.com/x.png")', B5: '=IMAGE("drive:pic123", 4, 0, 10)', B6: '=IMAGE("drive:pic123", 9)', B7: '=IMAGE("drive:pic123", 4, 5000, 20)' });
  assert.equal(v('B1'), '');
  assert.deepEqual(v.imageOf('B1'), { id: 'pic123', mode: 1 });
  assert.deepEqual(v.imageOf('B2'), { id: 'pic123', mode: 2 });
  assert.deepEqual(v.imageOf('B3'), { id: 'pic123', mode: 4, h: 80, w: 120 });
  for (const k of ['B4', 'B5', 'B6']) { assert.deepEqual(v(k), { error: '#VALUE!' }, k); assert.equal(v.imageOf(k), null); }
  assert.equal(v.imageOf('B7').h, 1000, 'at most 1000 pixels');
  assert.equal(v.imageOf('A1'), null);
  assert.equal(pictureId(' drive:abc_D-9 '), 'abc_D-9');
  assert.equal(pictureId('drive:../x'), null);
  assert.equal(imageFormula('abcd'), '=IMAGE("drive:abcd")');
  assert.equal(imageFormula('abcd', 3), '=IMAGE("drive:abcd", 3)');
  assert.equal(imageFormula('abcd', 4, 60.4, 90), '=IMAGE("drive:abcd", 4, 60, 90)');
});
