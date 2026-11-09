import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQuery, parseQuery, QueryError } from './query.js';
import { createEvaluator } from './formula.js';

const SALES = [
  ['Region', 'Rep', 'Amount', 'Date'],
  ['North', 'Ana', 120, '2026-01-15'],
  ['South', 'Ben', 80, '2026-02-03'],
  ['North', 'Cleo', 200, '2026-02-20'],
  ['East', 'Dev', 50, '2026-03-01'],
  ['South', 'Eve', null, '2026-03-09'],
];

test('select, where, order by, limit and offset', () => {
  assert.deepEqual(runQuery(SALES, 'select B, C where A = \'North\' order by C desc'), [['Rep', 'Amount'], ['Cleo', 200], ['Ana', 120]]);
  assert.deepEqual(runQuery(SALES, 'select B where C > 60 and not A = "South"'), [['Rep'], ['Ana'], ['Cleo']]);
  assert.deepEqual(runQuery(SALES, 'select B where C is null'), [['Rep'], ['Eve']]);
  assert.deepEqual(runQuery(SALES, 'select B, C order by C limit 2 offset 1'), [['Rep', 'Amount'], ['Dev', 50], ['Ben', 80]], 'blanks sort first going up');
  assert.deepEqual(runQuery(SALES, "select B where D >= date '2026-02-01' and D < date '2026-03-01'"), [['Rep'], ['Ben'], ['Cleo']]);
  assert.deepEqual(runQuery(SALES, "select B where B contains 'e' or B starts with 'A'"), [['Rep'], ['Ana'], ['Ben'], ['Cleo'], ['Dev'], ['Eve']]);
  assert.deepEqual(runQuery(SALES, "select B where B matches '[AB].*' "), [['Rep'], ['Ana'], ['Ben']]);
  assert.deepEqual(runQuery(SALES, "select B where B like '_e%'"), [['Rep'], ['Ben'], ['Dev']]);
  assert.deepEqual(runQuery(SALES, 'select B where A = "north"'), [['Rep']], 'text matches case, as in Google Sheets');
  assert.deepEqual(runQuery(SALES, 'select * where C > 150'), [SALES[0], SALES[3]]);
  assert.deepEqual(runQuery(SALES, 'select C * 2, upper(B) where C > 150 label C * 2 "Double"'), [['Double', 'upper(B)'], [400, 'CLEO']]);
});

test('group by with aggregates, labels and order', () => {
  assert.deepEqual(runQuery(SALES, 'select A, sum(C), count(B) group by A'), [['Region', 'sum Amount', 'count Rep'], ['East', 50, 1], ['North', 320, 2], ['South', 80, 2]]);
  assert.deepEqual(runQuery(SALES, 'select A, sum(C) group by A order by sum(C) desc label sum(C) "Total"'), [['Region', 'Total'], ['North', 320], ['South', 80], ['East', 50]]);
  assert.deepEqual(runQuery(SALES, 'select avg(C), max(D), min(B)'), [['avg Amount', 'max Date', 'min Rep'], [112.5, '2026-03-09', 'Ana']]);
  assert.deepEqual(runQuery(SALES, 'select month(D), count(B) group by month(D)'), [['month(D)', 'count Rep'], [0, 1], [1, 2], [2, 2]], 'month() counts from 0');
  assert.deepEqual(runQuery(SALES, "select count(B) where A = 'West'"), [['count Rep'], [0]]);
});

test('pivot makes a column for each value', () => {
  const rows = [['Region', 'Quarter', 'Amount'], ['North', 'Q1', 10], ['North', 'Q2', 5], ['South', 'Q1', 7], ['North', 'Q1', 1]];
  assert.deepEqual(runQuery(rows, 'select A, sum(C) group by A pivot B'), [['Region', 'Q1', 'Q2'], ['North', 11, 5], ['South', 7, null]]);
  assert.deepEqual(runQuery(rows, 'select sum(C) pivot A'), [['North', 'South'], [16, 7]]);
});

test('headings: guessed, given, or none', () => {
  const plain = [[1, 'a'], [2, 'b']];
  assert.deepEqual(runQuery(plain, 'select B where A > 1'), [['b']], 'no headings: no heading row');
  assert.deepEqual(runQuery(SALES, 'select A limit 1', 0), [['Region']], 'headers 0: the first row is data');
  assert.deepEqual(runQuery([['Top', 'x'], ['Name', 'Qty'], ['Pen', 3]], 'select A, B', 2), [['Top Name', 'x Qty'], ['Pen', 3]], 'two heading rows are joined');
  assert.deepEqual(runQuery([[1, 2], [3, 4]], 'select Col2', null, null), [[2], [4]], 'data with no place on the sheet uses Col1, Col2…');
  assert.deepEqual(runQuery([[5, 6]], 'select D', 0, 2), [[6]], 'a range starting in column C: its second column is D');
});

test('mistakes say what is wrong', () => {
  const bad = (q, re) => assert.throws(() => runQuery(SALES, q), (e) => e instanceof QueryError && re.test(e.message), q);
  bad('select Z', /no column Z/);
  bad('select A, sum(C)', /needs to be in "group by"/);
  bad('select A where', /ends too soon/);
  bad('select A A', /Unexpected/);
  bad('select A limit x', /whole number/);
  bad('select frob(A)', /no function/);
  bad('select A pivot B', /aggregate/);
  assert.equal(parseQuery('').select, null, 'an empty query selects everything');
});

test('QUERY in a cell spills its rows, and errors say why', () => {
  const v = createEvaluator({
    A1: 'Fruit', B1: 'Qty', A2: 'Apple', B2: '3', A3: 'Pear', B3: '5', A4: 'Apple', B4: '4',
    D1: '=QUERY(A1:B4, "select A, sum(B) group by A order by sum(B) desc")',
    G1: '=QUERY(A1:B4, "select B where A = \'Pear\'", 0)',
    H1: '=QUERY(A1:B4, "select A where B > 99")',
    I1: '=QUERY(A1:B4, "select Q")',
    J1: '=SUM(QUERY(A2:B4, "select B where A = \'Apple\'"))',
  });
  assert.deepEqual([v('D1'), v('E1'), v('D2'), v('E2'), v('D3'), v('E3')], ['Fruit', 'sum Qty', 'Apple', 7, 'Pear', 5]);
  assert.equal(v('G1'), 5, 'one value comes back as a value');
  assert.deepEqual([v('H1'), v('H2')], ['Fruit', null], 'no rows: just the heading');
  assert.deepEqual(v('I1'), { error: '#VALUE!', why: "There's no column Q in the data" });
  assert.equal(v('J1'), 7);
});
