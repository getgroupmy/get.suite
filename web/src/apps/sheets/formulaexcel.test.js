// Functions and array constants that Excel and Google Sheets files commonly use, which used to give #NAME? or #ERROR!.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluator } from './formula.js';

const cells = { A2: 1, A3: 2, A4: 3, B2: 'a', B3: 'b', B4: 'c' };
const v = (f) => createEvaluator({ ...cells, Z1: f })('Z1');
const near = (f, want, eps = 1e-6) => { const got = v(f); assert.ok(typeof got === 'number' && Math.abs(got - want) < eps, `${f} gave ${JSON.stringify(got)}, not ${want}`); };

test('array constants: {1,2,3} across, {1;2} down, {1,2;3,4}', () => {
  assert.equal(v('=SUM({1,2,3})'), 6);
  assert.equal(v('=SUM({1,2;3,4})'), 10);
  assert.equal(v('=INDEX({10,20;30,40},2,1)'), 30);
  assert.equal(v('=ROWS({1;2;3})'), 3);
  assert.equal(v('=COLUMNS({1,2,3})'), 3);
  assert.equal(v('=VLOOKUP(2,{1,"one";2,"two"},2,FALSE)'), 'two');
  assert.equal(v('=SUM({-1,2.5,"x"})'), 1.5, 'negative numbers and text in them');
  assert.equal(v('=SUM({1,2}*10)'), 30, 'worked out item by item');
  assert.equal(v('=INDEX({1,2,3},1,3)'), 3);
  assert.equal(v('={7,8,9}'), 7, 'in one cell: the first (it spills into the cells beside it)');
  assert.deepEqual(v('={1,2;3}'), { error: '#ERROR!' }, 'rows of different lengths');
});

test('trigonometry', () => {
  assert.equal(v('=SIN(0)'), 0);
  near('=COS(PI())', -1);
  near('=TAN(PI()/4)', 1);
  near('=DEGREES(ASIN(1))', 90);
  near('=ATAN2(1,1)', Math.PI / 4);
  near('=RADIANS(180)', Math.PI);
  near('=SINH(1)', Math.sinh(1));
  assert.deepEqual(v('=ACOS(2)'), { error: '#NUM!' });
  assert.deepEqual(v('=ATAN2(0,0)'), { error: '#DIV/0!' });
});

test('errors and kinds of value', () => {
  assert.equal(v('=ISNA(NA())'), true);
  assert.equal(v('=ISNA(1/0)'), false);
  assert.equal(v('=ISERR(1/0)'), true);
  assert.equal(v('=ISERR(NA())'), false);
  assert.equal(v('=ERROR.TYPE(1/0)'), 2);
  assert.equal(v('=ERROR.TYPE(NA())'), 7);
  assert.deepEqual(v('=ERROR.TYPE(1)'), { error: '#N/A' });
  assert.equal(v('=IF(ISNA(MATCH(9,A2:A4,0)),"missing","found")'), 'missing');
  assert.deepEqual([v('=TRUE()'), v('=FALSE()'), v('=XOR(TRUE,FALSE,TRUE)'), v('=ISLOGICAL(TRUE)')], [true, false, false, true]);
  assert.deepEqual([v('=N(5)'), v('=N("x")'), v('=N(TRUE)'), v('=T("x")'), v('=T(5)')], [5, 0, 1, 'x', '']);
  assert.deepEqual([v('=TYPE(1)'), v('=TYPE("a")'), v('=TYPE(TRUE)'), v('=TYPE({1,2})')], [1, 2, 4, 64]);
});

test('LOOKUP and REPLACE', () => {
  assert.equal(v('=LOOKUP(2.5,A2:A4,B2:B4)'), 'b', 'the last one at or below');
  assert.equal(v('=LOOKUP(3,A2:B4)'), 'c', 'a table: its first column searched, its last one given');
  assert.equal(v('=LOOKUP(2,{1,2,3},{"x","y","z"})'), 'y');
  assert.deepEqual(v('=LOOKUP(0,A2:A4,B2:B4)'), { error: '#N/A' });
  assert.equal(v('=REPLACE("abcdef",2,3,"XY")'), 'aXYef');
});

test('statistics, counting and money', () => {
  assert.equal(v('=MAXA(1,TRUE,0.5)'), 1);
  assert.equal(v('=TRIMMEAN({1,2,3,4,100},0.4)'), 3);
  near('=HARMEAN(1,2,4)', 12 / 7);
  assert.equal(v('=RANK.AVG(2,{1,2,2,3})'), 2.5);
  assert.equal(v('=PERCENTILE.EXC({1,2,3,4},0.5)'), 2.5);
  assert.equal(v('=SUMXMY2({1,2},{2,3})'), 2);
  assert.equal(v('=SUMX2MY2({2,3},{1,1})'), 11);
  near('=STEYX({2,3,9,1,8,7,5},{6,5,11,7,5,4,4})', 3.305719);
  near('=GAMMA(5)', 24);
  near('=ERF(1)', 0.842701);
  near('=FISHER(0.75)', 0.972955);
  near('=WEIBULL.DIST(105,20,100,TRUE)', 0.929581);
  near('=LOGNORM.DIST(4,3.5,1.2,TRUE)', 0.039084);
  near('=BETA.DIST(2,8,10,TRUE,1,3)', 0.685471);
  assert.deepEqual([v('=COMBINA(4,3)'), v('=FACTDOUBLE(7)'), v('=MULTINOMIAL(2,3,4)'), v('=BITAND(12,10)'), v('=BITXOR(5,3)')], [20, 105, 1260, 8, 6]);
  assert.deepEqual([v('=CEILING.MATH(-5.5,2,-1)'), v('=FLOOR.MATH(-5.5,2,-1)'), v('=CEILING.MATH(4.2)')], [-6, -4, 5]);
  near('=MIRR({-120000,39000,30000,21000,37000,46000},0.1,0.12)', 0.126094);
  near('=RRI(96,10000,11000)', 0.000993);
  near('=FVSCHEDULE(1,{0.09,0.11,0.1})', 1.33089);
  assert.deepEqual([v('=DAYS360("2026-01-30","2026-03-31")'), v('=DAYS360("2026-01-31","2026-02-28")'), v('=DAYS360("2026-01-31","2026-03-31",TRUE)')], [60, 28, 60]);
});
