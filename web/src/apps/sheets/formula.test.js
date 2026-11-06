import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluator, colName, colIndex, shiftFormula, display } from './formula.js';

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
