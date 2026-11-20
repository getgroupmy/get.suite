// The statistics, finance, date, database and array functions added on top of the basics, and functions
// working cell by cell over ranges (=LEN(A1:A3)), checked against the values Excel gives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluator, bookEvaluator } from './formula.js';
import { parseDateText, parseTimeText, yearFrac, normInv, tInv, gammaP, betaI } from './statmath.js';

const ev = (cells) => createEvaluator(cells);
const near = (a, b, tol = 1e-7) => assert.ok(typeof a === 'number' && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${JSON.stringify(a)} is not ${b}`);
/** One formula's value, with A1:A9 and B1:B9 holding sample numbers. */
const one = (formula, cells = {}) => ev({ ...cells, Z1: formula })('Z1');

test('the maths underneath: incomplete gamma and beta, inverses', () => {
  near(gammaP(1, 1), 1 - Math.exp(-1));
  near(gammaP(3, 10), 0.9972306664580);
  near(betaI(2, 3, 0.4), 0.5248);
  near(normInv(0.5), 0, 1e-12);
  near(normInv(0.025), -1.959963984540054);
  near(tInv(0.95, 1), 6.313751514675);
});

test('the normal distribution', () => {
  near(one('=NORM.DIST(42, 40, 1.5, TRUE)'), 0.9087887802);
  near(one('=NORM.DIST(42, 40, 1.5, FALSE)'), 0.1093400498);
  near(one('=NORMDIST(42, 40, 1.5, TRUE)'), 0.9087887802);
  near(one('=NORM.S.DIST(1.333333, TRUE)'), 0.9087887);
  near(one('=NORM.S.DIST(1.333333, FALSE)'), 0.1640101);
  near(one('=NORMSDIST(-1.96)'), 0.0249978951);
  near(one('=NORM.INV(0.908789, 40, 1.5)'), 42.00000201);
  near(one('=NORM.S.INV(0.908789)'), 1.3333347);
  near(one('=NORMSINV(0.975)'), 1.959963985);
  near(one('=STANDARDIZE(42, 40, 1.5)'), 1.3333333333);
  assert.deepEqual(one('=NORM.INV(1.2, 0, 1)'), { error: '#NUM!' });
  assert.deepEqual(one('=NORM.DIST(1, 0, 0, TRUE)'), { error: '#NUM!' });
});

test('shape of the numbers: SKEW, KURT, covariance, deviations, PERCENTRANK', () => {
  const data = { A1: '3', A2: '4', A3: '5', A4: '2', A5: '3', A6: '4', A7: '5', A8: '6', A9: '4', A10: '7' };
  near(one('=SKEW(A1:A10)', data), 0.359543071);
  near(one('=KURT(A1:A10)', data), -0.151799637);
  assert.deepEqual(one('=SKEW(1, 2)'), { error: '#DIV/0!' });
  const xy = { A1: '3', A2: '2', A3: '4', A4: '5', A5: '6', B1: '9', B2: '7', B3: '12', B4: '15', B5: '17' };
  near(one('=COVAR(A1:A5, B1:B5)', xy), 5.2);
  near(one('=COVARIANCE.P(A1:A5, B1:B5)', xy), 5.2);
  near(one('=COVARIANCE.S(A1:A5, B1:B5)', xy), 6.5);
  near(one('=DEVSQ(4, 5, 8, 7, 11, 4, 3)'), 48);
  near(one('=AVEDEV(4, 5, 6, 7, 5, 4, 3)'), 1.020408163);
  near(one('=SUMSQ(3, 4)'), 25);
  const pr = { A1: '13', A2: '12', A3: '11', A4: '8', A5: '4', A6: '3', A7: '2', A8: '1', A9: '1', A10: '1' };
  near(one('=PERCENTRANK(A1:A10, 2)', pr), 0.333);
  near(one('=PERCENTRANK(A1:A10, 4)', pr), 0.555);
  near(one('=PERCENTRANK(A1:A10, 8)', pr), 0.666);
  near(one('=PERCENTRANK(A1:A10, 5.43)', pr), 0.595, 1e-12); // between 4 (5/9) and 8 (6/9), cut to 3 digits
  near(one('=PERCENTRANK.INC(A1:A10, 5.43, 1)', pr), 0.5);
  assert.deepEqual(one('=PERCENTRANK(A1:A10, 20)', pr), { error: '#N/A' });
});

test('counting distributions: binomial, Poisson, exponential', () => {
  near(one('=BINOM.DIST(6, 10, 0.5, FALSE)'), 0.205078125);
  near(one('=BINOMDIST(6, 10, 0.5, TRUE)'), 0.828125);
  near(one('=POISSON.DIST(2, 5, TRUE)'), 0.124652019);
  near(one('=POISSON(2, 5, FALSE)'), 0.084224337);
  near(one('=EXPON.DIST(0.2, 10, TRUE)'), 0.864664717);
  near(one('=EXPONDIST(0.2, 10, FALSE)'), 1.353352832);
  assert.deepEqual(one('=BINOM.DIST(11, 10, 0.5, TRUE)'), { error: '#NUM!' });
});

test("Student's t, chi-squared, confidence and z-tests", () => {
  near(one('=T.DIST(60, 1, TRUE)'), 0.99469533);
  near(one('=T.DIST(8, 3, FALSE)'), 0.00073691);
  near(one('=T.DIST.2T(1.959999998, 60)'), 0.054644930);
  near(one('=T.DIST.RT(1.959999998, 60)'), 0.027322465);
  near(one('=TDIST(1.959999998, 60, 2)'), 0.054644930);
  near(one('=T.INV(0.75, 2)'), 0.8164966);
  near(one('=T.INV.2T(0.546449, 60)'), 0.606533076);
  near(one('=TINV(0.05, 10)'), 2.228138852);
  const t = { A1: '3', A2: '4', A3: '5', A4: '8', A5: '9', A6: '1', A7: '2', A8: '4', A9: '5', B1: '6', B2: '19', B3: '3', B4: '2', B5: '14', B6: '4', B7: '5', B8: '17', B9: '1' };
  near(one('=T.TEST(A1:A9, B1:B9, 2, 1)', t), 0.196015785);
  near(one('=TTEST(A1:A9, B1:B9, 2, 2)', t), 0.191995887);
  const welch = one('=T.TEST(A1:A9, B1:B9, 1, 3)', t);
  near(welch, 0.101146962, 1e-6);
  assert.ok(welch > 0.191995887 / 2, 'fewer degrees of freedom than with equal variances: a larger p');
  assert.deepEqual(one('=T.TEST(A1:A9, B1:B9, 3, 1)', t), { error: '#NUM!' });
  near(one('=CHISQ.DIST(0.5, 1, TRUE)'), 0.52049988);
  near(one('=CHISQ.DIST(2, 3, FALSE)'), 0.20755375);
  near(one('=CHISQ.DIST.RT(18.307, 10)'), 0.0500006);
  near(one('=CHIDIST(18.307, 10)'), 0.0500006);
  const chi = { A1: '58', A2: '11', A3: '10', B1: '35', B2: '25', B3: '23', C1: '45.35', C2: '17.56', C3: '16.09', D1: '47.65', D2: '18.44', D3: '16.91' };
  near(one('=CHISQ.TEST(A1:B3, C1:D3)', chi), 0.000308192);
  near(one('=CONFIDENCE.NORM(0.05, 2.5, 50)'), 0.692951912);
  near(one('=CONFIDENCE(0.05, 2.5, 50)'), 0.692951912);
  near(one('=CONFIDENCE.T(0.05, 1, 50)'), 0.284196855);
  const z = { A1: '3', A2: '6', A3: '7', A4: '8', A5: '6', A6: '5', A7: '4', A8: '2', A9: '1', A10: '9' };
  near(one('=Z.TEST(A1:A10, 4)', z), 0.090574197);
  near(one('=ZTEST(A1:A10, 6)', z), 0.863043, 1e-6);
});

test('lines and curves through points: TREND, GROWTH, LINEST, LOGEST', () => {
  const pts = { A1: '1', A2: '2', A3: '3', A4: '4', B1: '3', B2: '5', B3: '7', B4: '9' };
  const v = ev({ ...pts, D1: '=TREND(B1:B4, A1:A4, A5:A6)', A5: '5', A6: '6', E1: '=LINEST(B1:B4, A1:A4)', D4: '=TREND(B1:B4)' });
  near(v('D1'), 11); near(v('D2'), 13);
  near(v('E1'), 2); near(v('F1'), 1);
  near(v('D4'), 3); near(v('D7'), 9);
  const g = { A1: '11', A2: '12', A3: '13', A4: '14', A5: '15', A6: '16', B1: '33100', B2: '47300', B3: '69000', B4: '102000', B5: '150000', B6: '220000' };
  const w = ev({ ...g, D1: '=GROWTH(B1:B6, A1:A6, 17)', E1: '=LOGEST(B1:B6, A1:A6)' });
  near(w('D1'), 320196.7184, 1e-6);
  near(w('E1'), 1.463275628, 1e-6);
  near(w('F1'), 495.3047702, 1e-6);
});

test('rates, loan payments and depreciation', () => {
  near(one('=EFFECT(0.0525, 4)'), 0.053542667);
  near(one('=NOMINAL(0.053543, 4)'), 0.052500319);
  near(one('=IPMT(0.1/12, 1, 3*12, 8000)'), -66.66666667);
  near(one('=IPMT(0.1, 3, 3, 8000)'), -292.4471299);
  near(one('=PPMT(0.1/12, 1, 2*12, 2000)'), -75.62318601);
  near(one('=PPMT(0.08, 10, 10, 200000)'), -27598.05346);
  near(one('=IPMT(0.1/12, 1, 36, 8000, 0, 1)'), 0, 1e-12);
  near(one('=CUMIPMT(0.09/12, 30*12, 125000, 13, 24, 0)'), -11135.23213);
  near(one('=CUMIPMT(0.09/12, 30*12, 125000, 1, 1, 0)'), -937.5);
  near(one('=CUMPRINC(0.09/12, 30*12, 125000, 13, 24, 0)'), -934.1071234);
  near(one('=CUMPRINC(0.09/12, 30*12, 125000, 1, 1, 0)'), -68.27827118);
  near(one('=ISPMT(0.1/12, 1, 36, 8000000)'), -64814.81481);
  near(one('=SLN(30000, 7500, 10)'), 2250);
  near(one('=SYD(30000, 7500, 10, 1)'), 4090.909091);
  near(one('=SYD(30000, 7500, 10, 10)'), 409.0909091);
  near(one('=DDB(2400, 300, 3650, 1)'), 1.315068493);
  near(one('=DDB(2400, 300, 120, 1, 2)'), 40);
  near(one('=DDB(2400, 300, 10, 1, 2)'), 480);
  near(one('=DDB(2400, 300, 10, 2, 1.5)'), 306);
  near(one('=DDB(2400, 300, 10, 10)'), 22.1225472);
  near(one('=DB(1000000, 100000, 6, 1, 7)'), 186083.3333);
  near(one('=DB(1000000, 100000, 6, 2, 7)'), 259639.4167);
  near(one('=DB(1000000, 100000, 6, 7, 7)'), 15845.09847);
  assert.deepEqual(one('=DB(1000000, 100000, 6, 7)'), { error: '#NUM!' });
  assert.deepEqual(one('=CUMIPMT(0.09/12, 360, 125000, 0, 1, 0)'), { error: '#NUM!' });
});

test('dates in words, times and fractions of a year', () => {
  assert.equal(one('=DATEVALUE("2026-11-09")'), 46335);
  assert.equal(one('=DATEVALUE("9 Nov 2026")'), 46335);
  assert.equal(one('=DATEVALUE("November 9, 2026")'), 46335);
  assert.equal(one('=DATEVALUE("9/11/2026")'), 46335, 'day first');
  assert.equal(one('=DATEVALUE("11/25/2026")'), 46351, 'a month can only be the first number here');
  assert.deepEqual(one('=DATEVALUE("31 April 2026")'), { error: '#VALUE!' });
  assert.deepEqual(one('=DATEVALUE("soon")'), { error: '#VALUE!' });
  near(one('=TIMEVALUE("2:24 pm")'), 0.6);
  near(one('=TIMEVALUE("2026-11-09 06:00")'), 0.25);
  assert.equal(one('=TO_DATE(46335)'), '2026-11-09');
  assert.equal(one('=TO_DATE(DATEVALUE("9 Nov 2026") + 7)'), '2026-11-16');
  near(one('=YEARFRAC("2012-01-01", "2012-07-30")'), 0.580555556);
  near(one('=YEARFRAC("2012-01-01", "2012-07-30", 1)'), 0.576502732);
  near(one('=YEARFRAC("2012-01-01", "2012-07-30", 3)'), 0.578082192);
  near(one('=YEARFRAC("2012-01-01", "2012-07-30", 2)'), 211 / 360);
  near(one('=YEARFRAC(DATE(2010, 1, 1), DATE(2013, 6, 30), 1)'), 1276 / 365.25); // over several years: their average length
  near(yearFrac(Date.UTC(2006, 0, 31), Date.UTC(2006, 2, 31), 4), 0.166666667);
  assert.deepEqual(one('=YEARFRAC("2012-01-01", "2012-07-30", 5)'), { error: '#NUM!' });
  assert.equal(parseDateText('Nov 9', { year: 2027 }), Date.UTC(2027, 10, 9));
  assert.equal(parseDateText('9/11/2026', { monthFirst: true }), Date.UTC(2026, 8, 11));
  assert.equal(parseTimeText('13 pm'), null);
});

test('text and information: ISURL, ISEMAIL, ENCODEURL, ARABIC, DECIMAL, ADDRESS, ISFORMULA, FORMULATEXT', () => {
  assert.equal(one('=ISURL("https://example.com/a?b=1")'), true);
  assert.equal(one('=ISURL("not a link")'), false);
  assert.equal(one('=ISEMAIL("ann@example.com")'), true);
  assert.equal(one('=ISEMAIL("ann@")'), false);
  assert.equal(one('=ENCODEURL("a b&c")'), 'a%20b%26c');
  assert.equal(one('=ARABIC("MCMXCIV")'), 1994);
  assert.equal(one('=ARABIC(ROMAN(2026))'), 2026);
  assert.deepEqual(one('=ARABIC("ABC")'), { error: '#VALUE!' });
  assert.equal(one('=DECIMAL("FF", 16)'), 255);
  assert.equal(one('=DECIMAL("zap", 36)'), 35 * 36 * 36 + 10 * 36 + 25);
  assert.equal(one('=ADDRESS(2, 3)'), '$C$2');
  assert.equal(one('=ADDRESS(2, 3, 2)'), 'C$2');
  assert.equal(one('=ADDRESS(2, 3, 4)'), 'C2');
  assert.equal(one('=ADDRESS(2, 3, 1, FALSE)'), 'R2C3');
  assert.equal(one('=ADDRESS(2, 3, 4, FALSE)'), 'R[2]C[3]');
  assert.equal(one('=ADDRESS(1, 28, 1, TRUE, "Q4 sales")'), "'Q4 sales'!$AB$1");
  const v = ev({ A1: '=1+2', A2: '5', B1: '=ISFORMULA(A1)', B2: '=ISFORMULA(A2)', B3: '=FORMULATEXT(A1)', B4: '=FORMULATEXT(A2)' });
  assert.equal(v('B1'), true);
  assert.equal(v('B2'), false);
  assert.equal(v('B3'), '=1+2');
  assert.deepEqual(v('B4'), { error: '#N/A' });
});

test('arrays: MMULT, SORTN, COUNTUNIQUEIFS', () => {
  const v = ev({ A1: '1', B1: '2', A2: '3', B2: '4', C1: '5', C2: '6', E1: '=MMULT(A1:B2, C1:C2)', F1: '=MMULT(A1:B2, A1:B2)' });
  assert.deepEqual([v('E1'), v('E2')], [17, 39]);
  assert.deepEqual([v('F1'), v('G1'), v('F2'), v('G2')], [7, 10, 15, 22]);
  assert.deepEqual(one('=MMULT(A1:B2, C1:D1)', { A1: '1', B1: '2', A2: '3', B2: '4', C1: '1', D1: '2' }), { error: '#VALUE!' });
  const scores = { A1: 'Ann', B1: '90', A2: 'Bob', B2: '75', A3: 'Cat', B3: '90', A4: 'Dan', B4: '60', A5: 'Ann', B5: '90' };
  const s = ev({ ...scores, D1: '=SORTN(A1:B5, 2, 0, 2, FALSE)' });
  assert.deepEqual([s('D1'), s('E1'), s('D2'), s('E2'), s('D3')], ['Ann', 90, 'Cat', 90, null]);
  const t = ev({ ...scores, D1: '=SORTN(A1:B5, 1, 1, 2, FALSE)' });
  assert.deepEqual([t('D1'), t('D2'), t('D3'), t('D4')], ['Ann', 'Cat', 'Ann', null], 'ties with the last row come too');
  const u = ev({ ...scores, D1: '=SORTN(A1:B5, 3, 2, 2, FALSE)' });
  assert.deepEqual([u('D1'), u('D2'), u('D3'), u('D4')], ['Ann', 'Cat', 'Bob', null], 'repeated rows left out');
  assert.equal(one('=COUNTUNIQUEIFS(A1:A5, B1:B5, ">=90")', scores), 2);
});

test('database functions: a table, a column, and a criteria range (rows are OR, cells in a row AND)', () => {
  const db = {
    A1: 'Tree', B1: 'Height', C1: 'Age', D1: 'Yield', E1: 'Profit',
    A2: 'Apple', B2: '18', C2: '20', D2: '14', E2: '105',
    A3: 'Pear', B3: '12', C3: '12', D3: '10', E3: '96',
    A4: 'Cherry', B4: '13', C4: '14', D4: '9', E4: '105',
    A5: 'Apple', B5: '14', C5: '15', D5: '10', E5: '75',
    A6: 'Pear', B6: '9', C6: '8', D6: '8', E6: '76.8',
    A7: 'Apple', B7: '8', C7: '9', D7: '6', E7: '45',
    // criteria: apples taller than 10, or pears
    G1: 'Tree', H1: 'Height', G2: 'Apple', H2: '>10', G3: 'Pear',
    // just apples, taller than 10 and shorter than 16 (the same heading twice)
    J1: 'Tree', K1: 'Height', L1: 'Height', J2: 'Apple', K2: '>10', L2: '<16',
  };
  const v = ev({ ...db, Z1: '=DSUM(A1:E7, "Profit", G1:H3)', Z2: '=DCOUNT(A1:E7, "Age", G1:H3)', Z3: '=DAVERAGE(A1:E7, 4, G1:H3)',
    Z4: '=DMAX(A1:E7, "Profit", G1:H3)', Z5: '=DMIN(A1:E7, "profit", G1:H3)', Z6: '=DGET(A1:E7, "Yield", J1:L2)', Z7: '=DGET(A1:E7, "Yield", G1:H3)',
    Z8: '=DCOUNTA(A1:E7, "Tree", J1:L2)', Z9: '=DPRODUCT(A1:E7, "Yield", J1:L2)', Y1: '=DSUM(A1:E7, "Nope", G1:H3)' });
  near(v('Z1'), 105 + 96 + 75 + 76.8);
  assert.equal(v('Z2'), 4);
  near(v('Z3'), (14 + 10 + 10 + 8) / 4);
  assert.equal(v('Z4'), 105);
  assert.equal(v('Z5'), 75);
  assert.equal(v('Z6'), 10);
  assert.deepEqual(v('Z7'), { error: '#NUM!' }, 'more than one row matches');
  assert.equal(v('Z8'), 1);
  assert.equal(v('Z9'), 10);
  assert.deepEqual(v('Y1'), { error: '#VALUE!' });
});

test('functions of one value work cell by cell over ranges, and fill as many cells', () => {
  const v = ev({
    A1: 'pear', A2: 'fig', A3: 'banana', B1: '120', B2: '80', B3: '0',
    C1: '=LEN(A1:A3)', D1: '=IF(B1:B3>100, "big", "small")', E1: '=ROUND(B1:B3*1.234, 1)',
    F1: '=UPPER(A1:A3)&"!"', G1: '=IFERROR(100/B1:B3, "none")', H1: '=ARRAYFORMULA(B1:B3*2)',
    I1: '=SUM(LEN(A1:A3))', J1: '=100/B1:B3',
  });
  assert.deepEqual([v('C1'), v('C2'), v('C3')], [4, 3, 6]);
  assert.deepEqual([v('D1'), v('D2'), v('D3')], ['big', 'small', 'small']);
  assert.deepEqual([v('E1'), v('E2'), v('E3')], [148.1, 98.7, 0]);
  assert.deepEqual([v('F1'), v('F3')], ['PEAR!', 'BANANA!']);
  assert.deepEqual([v('G1'), v('G2'), v('G3')], [100 / 120, 1.25, 'none'], 'an error in one cell is caught on its own');
  assert.deepEqual([v('H1'), v('H2'), v('H3')], [240, 160, 0]);
  assert.equal(v('I1'), 13, 'used inside another function, nothing spills');
  assert.deepEqual([v('J1'), v('J2'), v('J3')], [100 / 120, 1.25, { error: '#DIV/0!' }], 'the other cells keep their values');
  assert.deepEqual(ev({ A1: '1', A2: '0', B1: '=SUM(1/A1:A2)' })('B1'), { error: '#DIV/0!' }, 'an error inside a range still counts');
  // VLOOKUP looks up each value but keeps its table whole; the cell under it must be free.
  const w = ev({ A1: 'b', A2: 'a', D1: 'a', E1: '1', D2: 'b', E2: '2', B1: '=VLOOKUP(A1:A2, D1:E2, 2, FALSE)' });
  assert.deepEqual([w('B1'), w('B2')], [2, 1]);
  const x = ev({ A1: 'b', A2: 'a', B2: 'taken', D1: 'a', E1: '1', D2: 'b', E2: '2', B1: '=VLOOKUP(A1:A2, D1:E2, 2, FALSE)' });
  assert.deepEqual(x('B1'), { error: '#SPILL!' });
  // A single cell stays a single value.
  assert.equal(ev({ A1: 'abc', B1: '=LEN(A1)' })('B1'), 3);
  const c = ev({ A1: '3', A2: '7', A3: '12', C1: '>5', C2: '>10', B1: '=COUNTIF(A1:A3, C1:C2)' });
  assert.deepEqual([c('B1'), c('B2')], [2, 1], 'COUNTIF with several conditions counts for each');
});

test('ISBETWEEN: numbers, dates and text, each end included unless told not to; cell by cell over a range', () => {
  assert.equal(one('=ISBETWEEN(5, 1, 10)'), true);
  assert.equal(one('=ISBETWEEN(10, 1, 10)'), true);
  assert.equal(one('=ISBETWEEN(10, 1, 10, TRUE, FALSE)'), false);
  assert.equal(one('=ISBETWEEN(1, 1, 10, FALSE)'), false);
  assert.equal(one('=ISBETWEEN(11, 1, 10)'), false);
  assert.equal(one('=ISBETWEEN(DATE(2026,11,18), DATE(2026,11,1), DATE(2026,11,30))'), true);
  assert.equal(one('=ISBETWEEN("m", "a", "z")'), true);
  assert.equal(one('=ISBETWEEN("Mango", "apple", "pear")'), true, 'text, ignoring case');
  assert.equal(one('=ISBETWEEN("zebra", "apple", "pear")'), false);
  assert.equal(ev({ A1: 1, A2: 5, A3: 20, B1: '=SUM(--ISBETWEEN(A1:A3, 2, 10))' })('B1'), 1);
});

test('DOLLAR: money text with thousands separators, negatives in brackets, places rounding', () => {
  assert.equal(one('=DOLLAR(1234.567)'), '$1,234.57');
  assert.equal(one('=DOLLAR(1234.567, 0)'), '$1,235');
  assert.equal(one('=DOLLAR(-1234.5, 1)'), '($1,234.5)');
  assert.equal(one('=DOLLAR(1234.567, -2)'), '$1,200');
  assert.equal(one('=DOLLAR(0.5)'), '$0.50');
  assert.equal(one('=DOLLAR(1000000)'), '$1,000,000.00');
});
test('ISDATE, EPOCHTODATE, ISREF and CELL', () => {
  assert.equal(one('=ISDATE(DATE(2026, 1, 2))'), true);
  assert.equal(one('=ISDATE("2026-11-20 14:30")'), true);
  assert.equal(one('=ISDATE("hello")'), false);
  assert.equal(one('=ISDATE(5)'), false);
  assert.equal(one('=EPOCHTODATE(1700000000)'), '2023-11-14 22:13:20');
  assert.equal(one('=EPOCHTODATE(1700000000000, 2)'), '2023-11-14 22:13:20');
  assert.equal(one('=EPOCHTODATE(86400000000, 3)'), '1970-01-02');
  assert.deepEqual(one('=EPOCHTODATE(-1)'), { error: '#NUM!' });
  assert.deepEqual(one('=EPOCHTODATE(1, 4)'), { error: '#NUM!' });
  assert.equal(one('=ISREF(A1)'), true);
  assert.equal(one('=ISREF(B2:C3)'), true);
  assert.equal(one('=ISREF(OFFSET(A1, 1, 1))'), true);
  assert.equal(one('=ISREF(5)'), false);
  assert.equal(one('=ISREF("A1")'), false);
  const cells = { A1: 'hi', A2: '42' };
  assert.equal(one('=CELL("address", B3:C4)', cells), '$B$3');
  assert.equal(one('=CELL("row", B3)', cells), 3);
  assert.equal(one('=CELL("col", C9)', cells), 3);
  assert.equal(one('=CELL("contents", A1:A3)', cells), 'hi');
  assert.equal(one('=CELL("contents", OFFSET(A1, 1, 0))', cells), 42);
  assert.deepEqual([one('=CELL("type", A1)', cells), one('=CELL("type", A2)', cells), one('=CELL("type", A9)', cells)], ['l', 'v', 'b']);
  assert.deepEqual(one('=CELL("width", A1)', cells), { error: '#VALUE!' });
  const book = bookEvaluator([{ name: 'Main', cells: { A1: '=CELL("address", \'Q4 sales\'!B2)', A2: '=CELL("contents", \'Q4 sales\'!B2:C3)', A3: '=ISREF(\'Q4 sales\'!B2)' } },
    { name: 'Q4 sales', cells: { B2: '7' } }], 0);
  assert.deepEqual([book('A1'), book('A2'), book('A3')], ["'Q4 sales'!$B$2", 7, true]);
});
test('SHEET, SHEETS, REGEXTEST, PERCENTOF, SECH, COTH, BITLSHIFT and BITRSHIFT', () => {
  near(one('=SECH(0)'), 1);
  near(one('=COTH(1)'), 1.3130352854993315);
  assert.deepEqual(one('=COTH(0)'), { error: '#DIV/0!' });
  assert.equal(one('=BITLSHIFT(4, 2)'), 16);
  assert.equal(one('=BITRSHIFT(13, 2)'), 3);
  assert.equal(one('=BITLSHIFT(12, -2)'), 3);
  assert.deepEqual(one('=BITLSHIFT(2^47, 1)'), { error: '#NUM!' });
  assert.deepEqual(one('=BITLSHIFT(-1, 1)'), { error: '#NUM!' });
  assert.equal(one('=REGEXTEST("Apple", "^a")'), false);
  assert.equal(one('=REGEXTEST("Apple", "^a", 1)'), true);
  assert.equal(one('=REGEXTEST("INV-2041", "^INV-\\d+$")'), true);
  assert.deepEqual(one('=REGEXTEST("x", "[")'), { error: '#VALUE!' });
  assert.deepEqual(one('=REGEXTEST("x", "x", 2)'), { error: '#VALUE!' });
  const cells = { A1: '10', A2: '30', A3: 'x' };
  assert.equal(one('=PERCENTOF(A1, A1:A3)', cells), 0.25);
  assert.deepEqual(one('=PERCENTOF(A1, B1:B2)', cells), { error: '#DIV/0!' });
  assert.equal(one('=SHEET()'), 1);
  assert.equal(one('=SHEETS()'), 1);
  const ev3 = bookEvaluator([{ name: 'Main', cells: { A1: '=SHEET()', A2: "=SHEET('Q4 sales'!B2)", A3: '=SHEET("q4 SALES")', A4: '=SHEETS()', A5: '=SHEET("Nope")', A6: "=SHEET(INDIRECT(\"'Q4 sales'!A1\"))" } },
    { name: 'Q4 sales', cells: {} }, { name: 'Other', cells: { A1: '=SHEET()' } }], 0);
  assert.deepEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].map(ev3), [1, 2, 2, 3, { error: '#N/A' }, 2]);
});
test('complex numbers: COMPLEX, IMREAL, IMSUM, IMPRODUCT, IMDIV, IMPOWER, IMSQRT, IMLN, IMSIN… (Excel\'s examples)', () => {
  assert.equal(one('=COMPLEX(3, 4)'), '3+4i');
  assert.equal(one('=COMPLEX(3, -1)'), '3-i');
  assert.equal(one('=COMPLEX(0, 1)'), 'i');
  assert.equal(one('=COMPLEX(0, -2.5, "j")'), '-2.5j');
  assert.equal(one('=COMPLEX(5, 0)'), '5');
  assert.deepEqual(one('=COMPLEX(1, 1, "k")'), { error: '#VALUE!' });
  assert.equal(one('=IMREAL("3+4i")'), 3);
  assert.equal(one('=IMAGINARY("3+4i")'), 4);
  assert.equal(one('=IMAGINARY("-i")'), -1);
  assert.equal(one('=IMAGINARY("4j")'), 4);
  assert.equal(one('=IMREAL("1.5e2-3i")'), 150);
  assert.equal(one('=IMABS("3+4i")'), 5);
  near(one('=IMARGUMENT("i")'), Math.PI / 2);
  assert.deepEqual(one('=IMARGUMENT(0)'), { error: '#DIV/0!' });
  assert.equal(one('=IMCONJUGATE("3+4i")'), '3-4i');
  assert.equal(one('=IMSUM("3+4i", "5-3i")'), '8+i');
  assert.equal(one('=IMSUM(A1:A2)', { A1: '1+2i', A2: '3' }), '4+2i');
  assert.equal(one('=IMSUB("13+4i", "5+3i")'), '8+i');
  assert.equal(one('=IMPRODUCT("3+4i", "5-3i")'), '27+11i');
  assert.equal(one('=IMDIV("-238+240i", "10+24i")'), '5+12i');
  assert.deepEqual(one('=IMDIV("1", "0")'), { error: '#NUM!' });
  assert.equal(one('=IMPOWER("2+3i", 3)'), '-46+9.00000000000001i');
  assert.equal(one('=IMSQRT("1+i")'), '1.09868411346781+0.455089860562227i');
  assert.equal(one('=IMEXP("1+i")'), '1.46869393991589+2.28735528717884i');
  assert.equal(one('=IMLN("3+4i")'), '1.6094379124341+0.927295218001612i');
  assert.equal(one('=IMLOG10("3+4i")'), '0.698970004336019+0.402719196273373i');
  assert.equal(one('=IMLOG2("3+4i")'), '2.32192809488736+1.33780421245098i');
  assert.equal(one('=IMSIN("4+3i")'), '-7.61923172032141-6.548120040911i');
  assert.equal(one('=IMCOS("1+i")'), '0.833730025131149-0.988897705762865i');
  assert.deepEqual(one('=IMLN(0)'), { error: '#NUM!' });
  assert.deepEqual(one('=IMSUM("1+i", "1+j")'), { error: '#VALUE!' }, 'i and j mixed');
  assert.deepEqual(one('=IMREAL("abc")'), { error: '#NUM!' });
  assert.deepEqual(one('=IMREAL("3+4")'), { error: '#NUM!' });
});
test('older names (FDIST, FINV, WEIBULL, GAMMADIST…), BETA.INV and PROB give Excel\'s documented answers', () => {
  near(one('=BETA.INV(0.685470581, 8, 10, 1, 3)'), 2, 1e-8);
  near(one('=BETAINV(0.685470581, 8, 10, 1, 3)'), 2, 1e-8);
  near(one('=BETADIST(2, 8, 10, 1, 3)'), 0.685470581, 1e-8);
  assert.deepEqual(one('=BETA.INV(1, 8, 10)'), { error: '#NUM!' });
  near(one('=FDIST(15.2068649, 6, 4)'), 0.01, 1e-7);
  near(one('=FINV(0.01, 6, 4)'), 15.2068649, 1e-7);
  near(one('=FTEST({6,7,9,15,21}, {20,28,31,38,40})'), 0.648317847, 1e-8);
  near(one('=WEIBULL(105, 20, 100, TRUE)'), 0.929581, 1e-6);
  near(one('=WEIBULL(105, 20, 100, FALSE)'), 0.035589, 1e-5);
  near(one('=HYPGEOMDIST(1, 4, 8, 20)'), 0.363261, 1e-6);
  near(one('=NEGBINOMDIST(10, 5, 0.25)'), 0.055049, 1e-5);
  near(one('=GAMMADIST(10.00001131, 9, 2, FALSE)'), 0.032639, 1e-5);
  near(one('=GAMMADIST(10.00001131, 9, 2, TRUE)'), 0.068094, 1e-5);
  near(one('=GAMMAINV(0.068094, 9, 2)'), 10.0000112, 1e-6);
  const c = { A1: '0', A2: '1', A3: '2', A4: '3', B1: '0.2', B2: '0.3', B3: '0.1', B4: '0.4' };
  near(one('=PROB(A1:A4, B1:B4, 2)', c), 0.1);
  near(one('=PROB(A1:A4, B1:B4, 1, 3)', c), 0.8);
  assert.deepEqual(one('=PROB(A1:A4, B1:B3, 1)', c), { error: '#N/A' });
  assert.deepEqual(one('=PROB(A1:A4, B1:B4, 1)', { ...c, B4: '0.5' }), { error: '#NUM!' }, "chances that don't add up to 1");
});
test('discounted securities and Treasury bills: DISC, INTRATE, RECEIVED, PRICEDISC, YIELDDISC, TBILLPRICE, TBILLYIELD, TBILLEQ', () => {
  near(one('=DISC(DATE(2018,7,1), DATE(2048,1,1), 97.975, 100, 1)'), 0.000686384, 1e-6);
  near(one('=INTRATE(DATE(2008,2,15), DATE(2008,5,15), 1000000, 1014420, 2)'), 0.05768);
  near(one('=RECEIVED(DATE(2008,2,15), DATE(2008,5,15), 1000000, 0.0575, 2)'), 1014584.654, 1e-9);
  near(one('=PRICEDISC(DATE(2008,2,16), DATE(2008,3,1), 0.0525, 100, 2)'), 99.79583333);
  near(one('=YIELDDISC(DATE(2008,2,16), DATE(2008,3,1), 99.795, 100, 2)'), 0.052822572);
  near(one('=TBILLPRICE(DATE(2008,3,31), DATE(2008,6,1), 0.09)'), 98.45);
  near(one('=TBILLYIELD(DATE(2008,3,31), DATE(2008,6,1), 98.45)'), 0.091416963);
  near(one('=TBILLEQ(DATE(2008,3,31), DATE(2008,6,1), 0.0914)'), 0.094151494);
  // over half a year: the yield y where price × (1 + y/2)(1 + y(days/365 − ½)) = 100
  const y = one('=TBILLEQ(DATE(2008,3,31), DATE(2008,12,1), 0.0914)'), n = 245, price = 100 * (1 - (0.0914 * n) / 360);
  near(price * (1 + y / 2) * (1 + y * (n / 365 - 0.5)), 100, 1e-9);
  assert.deepEqual(one('=TBILLEQ(DATE(2008,3,31), DATE(2009,6,1), 0.0914)'), { error: '#NUM!' }, 'over a year');
  assert.deepEqual(one('=DISC(DATE(2008,3,1), DATE(2008,2,1), 97, 100)'), { error: '#NUM!' }, 'maturity first');
  assert.deepEqual(one('=DISC(DATE(2008,2,1), DATE(2008,3,1), 97, 100, 5)'), { error: '#NUM!' }, 'no such day count');
  assert.deepEqual(one('=DISC(DATE(2008,2,1), DATE(2008,3,1), 0, 100)'), { error: '#NUM!' });
});
test('bonds: COUPPCD, COUPNCD, COUPNUM, COUPDAYS, COUPDAYBS, COUPDAYSNC, PRICE, YIELD, DURATION, MDURATION, PRICEMAT, YIELDMAT (Excel\'s examples)', () => {
  const A = 'DATE(2011,1,25), DATE(2011,11,15), 2, 1';
  assert.equal(one(`=COUPDAYBS(${A})`), 71);
  assert.equal(one(`=COUPDAYS(${A})`), 181);
  assert.equal(one(`=COUPDAYSNC(${A})`), 110);
  assert.equal(one(`=COUPNCD(${A})`), '2011-05-15');
  assert.equal(one(`=COUPNUM(${A})`), 2);
  assert.equal(one(`=COUPPCD(${A})`), '2010-11-15');
  assert.equal(one('=COUPDAYBS(DATE(2011,1,25), DATE(2011,11,15), 2)'), 70, '30/360');
  assert.equal(one('=COUPPCD(DATE(2011,3,15), DATE(2012,2,29), 4)'), '2011-02-28', 'maturing on the last of a month: coupons on the last of theirs');
  assert.deepEqual(one('=COUPNUM(DATE(2011,1,25), DATE(2011,11,15), 3)'), { error: '#NUM!' }, 'frequency 1, 2 or 4');
  assert.deepEqual(one('=COUPNUM(DATE(2012,1,25), DATE(2011,11,15), 2)'), { error: '#NUM!' }, 'settlement after maturity');
  near(one('=PRICE(DATE(2008,2,15), DATE(2017,11,15), 0.0575, 0.065, 100, 2, 0)'), 94.63436162);
  near(one('=YIELD(DATE(2008,2,15), DATE(2016,11,15), 0.0575, 95.04287, 100, 2, 0)'), 0.065, 1e-6);
  near(one('=YIELD(DATE(2008,2,15), DATE(2017,11,15), 0.0575, PRICE(DATE(2008,2,15), DATE(2017,11,15), 0.0575, 0.065, 100, 2, 0), 100, 2, 0)'), 0.065, 1e-9);
  near(one('=DURATION(DATE(2018,7,1), DATE(2048,1,1), 0.08, 0.09, 2, 1)'), 10.9191453);
  near(one('=MDURATION(DATE(2008,1,1), DATE(2016,1,1), 0.08, 0.09, 2, 1)'), 5.73567, 1e-6);
  near(one('=PRICEMAT(DATE(2008,2,15), DATE(2008,4,13), DATE(2007,11,11), 0.061, 0.061, 0)'), 99.98449888);
  near(one('=YIELDMAT(DATE(2008,3,15), DATE(2008,11,3), DATE(2007,11,8), 0.0625, 100.0123, 0)'), 0.060954334);
});
