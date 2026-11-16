import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learnFill, applyFill, describeFill, planSmartFill } from './smartfill.js';

const learn = (pairs) => learnFill(pairs.map(([inputs, output]) => ({ inputs: [].concat(inputs), output })));
const run = (p, inputs) => applyFill(p, [].concat(inputs));

test('initial and surname: J. Smith from John Smith', () => {
  const p = learn([['John Smith', 'J. Smith']]);
  assert.ok(p);
  assert.equal(run(p, 'Mary Jones'), 'M. Jones');
  assert.equal(run(p, 'Ana Maria Lopez'), 'A. Lopez', 'the last word, with a middle name');
  assert.equal(describeFill(p, ['A']), 'the first letter of the first word of A + “. ” + the last word of A');
});

test('surname, first name; with case changes', () => {
  const p = learn([['john smith', 'SMITH, John'], ['mary jones', 'JONES, Mary']]);
  assert.equal(run(p, 'peter parker'), 'PARKER, Peter');
});

test('from an email address: the name before the @ and the domain', () => {
  const dom = learn([['kim.park@acme.com', 'acme.com'], ['bo@globex.co.uk', 'globex.co.uk']]);
  assert.equal(run(dom, 'x@initech.com'), 'initech.com');
  const name = learn([['kim.park@acme.com', 'Kim Park']]);
  assert.equal(run(name, 'lee.wong@acme.com'), 'Lee Wong');
});

test('two columns joined', () => {
  const p = learn([[['Kim', 'Park'], 'kim.park@acme.com'], [['Lee', 'Wong'], 'lee.wong@acme.com']]);
  assert.equal(run(p, ['Ana', 'Lopez']), 'ana.lopez@acme.com');
});

test('a number out of text', () => {
  const p = learn([['Order #4521 (paid)', '4521'], ['Order #77 (due)', '77']]);
  assert.equal(run(p, 'Order #9 (paid)'), '9');
});

test('initials', () => {
  const p = learn([['John Ronald Tolkien', 'JRT'], ['Mary Ann Evans', 'MAE']]);
  assert.equal(run(p, 'Kim Lee Park'), 'KLP');
});

test('nothing to learn from, or examples that disagree: no pattern', () => {
  assert.equal(learn([['John Smith', 'banana']]), null, 'one example that is only fixed text');
  assert.equal(learn([['John Smith', 'J. Smith'], ['Mary Jones', 'Jones M']]), null);
  assert.equal(learnFill([]), null);
});

test('a row without the piece needed is left empty', () => {
  const p = learn([['John Smith', 'Smith'], ['Mary Ann Jones', 'Jones']]);
  assert.equal(run(p, ''), null);
});

test('planning on a table: examples, rows to fill, a heading row, errors', () => {
  const grid = [['Name', 'Short'], ['John Smith', 'J. Smith'], ['Mary Jones', ''], ['', ''], ['Ana Lopez', ''], ['Bo', '']];
  const value = (c, r) => grid[r]?.[c] ?? '';
  const p = planSmartFill({ r1: 0, r2: 5, target: 1, cols: [0], header: true, value });
  assert.equal(p.examples, 1);
  assert.deepEqual(p.fills.map((f) => [f.r, f.v]), [[2, 'M. Jones'], [4, 'A. Lopez'], [5, 'B. Bo']], 'one word: it is both the first and the last');
  assert.match(planSmartFill({ r1: 0, r2: 5, target: 1, cols: [], value }).error, /a column of data beside/);
  const empty = (c, r) => (c === 1 ? '' : value(c, r));
  assert.match(planSmartFill({ r1: 1, r2: 5, target: 1, cols: [0], value: empty }).error, /Type what you want/);
  const bad = (c, r) => (c === 1 && r === 2 ? 'zzz' : value(c, r));
  assert.match(planSmartFill({ r1: 1, r2: 5, target: 1, cols: [0], value: bad }).error, /No pattern/);
});

test('a heading row is found by itself when it spoils the pattern', () => {
  const g = [['Name', 'Short'], ['Kim Park', 'K. Park'], ['Lee Chan', '']];
  const p = planSmartFill({ r1: 0, r2: 2, target: 1, cols: [0], value: (c, r) => g[r]?.[c] ?? '' });
  assert.deepEqual(p.fills.map((f) => f.v), ['L. Chan']);
});

test('the top row of the table, empty in this column, is taken for headings and not filled', () => {
  const g = [['Name', ''], ['Kim Park', 'PARK'], ['Lee Chan', 'CHAN'], ['Bo Diaz', '']];
  const p = planSmartFill({ r1: 0, r2: 3, target: 1, cols: [0], value: (c, r) => g[r]?.[c] ?? '' });
  assert.deepEqual(p.fills.map((f) => [f.r, f.v]), [[3, 'DIAZ']]);
});

test('dates: read in several forms', async () => {
  const { parseDate } = await import('./smartfill.js');
  assert.deepEqual(parseDate('2026-11-05'), { y: 2026, m: 11, d: 5 });
  assert.deepEqual(parseDate('2026-11-05 14:30'), { y: 2026, m: 11, d: 5 });
  assert.deepEqual(parseDate('5/11/2026'), { y: 2026, m: 11, d: 5 }, 'day first');
  assert.deepEqual(parseDate('11/25/2026'), { y: 2026, m: 11, d: 25 }, 'month first when it must be');
  assert.deepEqual(parseDate('05.11.26'), { y: 2026, m: 11, d: 5 });
  assert.deepEqual(parseDate('5 Nov 2026'), { y: 2026, m: 11, d: 5 });
  assert.deepEqual(parseDate('November 5th, 2026'), { y: 2026, m: 11, d: 5 });
  for (const no of ['2026-02-30', 'hello', '12/13/14/15', '5 Foo 2026', '']) assert.equal(parseDate(no), null, no);
});

test('dates reformatted from one or two examples', () => {
  const p = learn([['2026-11-15', '15 Nov 2026']]);
  assert.equal(run(p, '2026-03-05'), '5 Mar 2026', 'the day without a leading zero');
  const q = learn([['15/11/2026', '2026-11-15'], ['5/3/2026', '2026-03-05']]);
  assert.equal(run(q, '25/12/2026'), '2026-12-25');
  const w = learn([['2026-11-16', 'Monday']]);
  assert.equal(run(w, '2026-11-20'), 'Friday');
  const m = learn([['2026-11-16', 'NOVEMBER 2026']]);
  assert.equal(run(m, '2027-01-02'), 'JANUARY 2027');
  assert.equal(run(p, 'not a date'), null, 'not a date: left empty');
  assert.match(describeFill(p, ['A']), /the day of the date in A \+ “ ” \+ the month name, short of the date in A/);
});
