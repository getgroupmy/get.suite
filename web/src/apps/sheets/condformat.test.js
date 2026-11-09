import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches, ruleStyle, describeRule } from './condformat.js';

test('conditions', () => {
  const r = (when, value, value2) => ({ when, value, value2 });
  assert.equal(matches(r('gt', '100'), 150), true);
  assert.equal(matches(r('gt', '100'), 100), false);
  assert.equal(matches(r('gte', '100'), 100), true);
  assert.equal(matches(r('lt', '0'), -1), true);
  assert.equal(matches(r('between', '10', '1'), 5), true, 'either order');
  assert.equal(matches(r('between', '1', '10'), 11), false);
  assert.equal(matches(r('eq', 'Done'), 'done'), true, 'text: any case');
  assert.equal(matches(r('eq', '5'), 5), true);
  assert.equal(matches(r('ne', 'Done'), 'Open'), true);
  assert.equal(matches(r('contains', 'late'), 'Paid late'), true);
  assert.equal(matches(r('notContains', 'late'), 'Paid'), true);
  assert.equal(matches(r('starts', 'inv'), 'INV-002'), true);
  assert.equal(matches(r('empty'), null), true);
  assert.equal(matches(r('notEmpty'), 0), true);
  assert.equal(matches(r('gt', '1'), 'text'), false, 'text is not a number');
  assert.equal(matches(r('error'), { error: '#DIV/0!' }), true);
  assert.equal(matches(r('gt', '1'), { error: '#DIV/0!' }), false);
});

test('the first matching rule for a cell wins', () => {
  const rules = [
    { range: 'B2:B10', when: 'gt', value: '100', fill: '#fce8e6', color: '#c5221f', bold: true },
    { range: 'B2:B10', when: 'gt', value: '0', fill: '#e6f4ea' },
  ];
  assert.deepEqual(ruleStyle(rules, 'B3', 150), { background: '#fce8e6', color: '#c5221f', fontWeight: 700 });
  assert.deepEqual(ruleStyle(rules, 'B3', 50), { background: '#e6f4ea' });
  assert.equal(ruleStyle(rules, 'C3', 150), null, 'outside the range');
  assert.equal(ruleStyle(rules, 'B3', -5), null);
  assert.equal(describeRule(rules[0]), 'B2:B10 · Greater than 100');
  assert.equal(describeRule({ range: 'A1:A5', when: 'between', value: '1', value2: '9' }), 'A1:A5 · Between 1 and 9');
  assert.equal(describeRule({ range: 'A1:A5', when: 'empty' }), 'A1:A5 · Is empty');
});

test('rules over the whole range: duplicates, unique, top and bottom, above and below average', async () => {
  const { ruleStyle, ruleContext, rangeStats, formulaFor, describeRule } = await import('./condformat.js');
  const { createEvaluator } = await import('./formula.js');
  const ev = createEvaluator({ A1: 'pear', A2: 'Apple', A3: 'apple', A4: 'kiwi', B1: 10, B2: 40, B3: 20, B4: 40, B5: 5, C1: 'x', C2: 'done', C3: 'x', C4: 'done' });
  const ctx = ruleContext(ev, ev.formulaAt);
  const on = (when, range, key, value) => !!ruleStyle([{ id: 'r', range, when, value, fill: '#f00' }], key, ev(key), ctx);
  assert.deepEqual(['A1', 'A2', 'A3', 'A4'].map((k) => on('duplicate', 'A1:A4', k)), [false, true, true, false], 'any case counts as the same');
  assert.deepEqual(['A1', 'A2', 'A4', 'A5'].map((k) => on('unique', 'A1:A5', k)), [true, false, true, false], 'blanks are neither');
  assert.deepEqual(['B1', 'B2', 'B3', 'B4', 'B5'].map((k) => on('top', 'B1:B5', k, '2')), [false, true, false, true, false]);
  assert.deepEqual(['B1', 'B2', 'B3', 'B4', 'B5'].map((k) => on('bottom', 'B1:B5', k, '2')), [true, false, false, false, true]);
  assert.deepEqual(['B1', 'B2', 'B3', 'B5'].map((k) => on('aboveAvg', 'B1:B5', k)), [false, true, false, false], 'average 23');
  assert.deepEqual(['B1', 'B2', 'B3', 'B5'].map((k) => on('belowAvg', 'B1:B5', k)), [true, false, true, true]);
  assert.equal(rangeStats({ range: 'B1:B5' }, ev).avg, 23);
  assert.equal(describeRule({ range: 'B1:B5', when: 'top', value: '3' }), 'B1:B5 · Top 3');
  // Without the sheet to look at (say, a rule list on its own), whole-range rules colour nothing.
  assert.equal(ruleStyle([{ range: 'A1:A4', when: 'duplicate' }], 'A2', 'Apple'), null);
});

test('custom formula rules move along the range like a copied formula', async () => {
  const { ruleStyle, ruleContext, formulaFor } = await import('./condformat.js');
  const { createEvaluator } = await import('./formula.js');
  const ev = createEvaluator({ A1: 'Ana', B1: 120, A2: 'Bo', B2: 80, A3: 'Cy', B3: 300, D1: 100 });
  const ctx = ruleContext(ev, ev.formulaAt);
  const rule = { id: 'f', range: 'A1:B3', when: 'formula', value: '=$B1>$D$1', fill: '#e6f4ea' };
  assert.equal(formulaFor(rule, 'A2'), '=$B2>$D$1');
  assert.equal(formulaFor(rule, 'B3'), '=$B3>$D$1');
  assert.deepEqual(['A1', 'B1', 'A2', 'B2', 'A3', 'B3'].map((k) => !!ruleStyle([rule], k, ev(k), ctx)), [true, true, false, false, true, true], 'whole rows by their B cell');
  assert.equal(!!ruleStyle([{ ...rule, value: 'ISEVEN(ROW())' }], 'A2', 'Bo', ctx), true, 'the = can be left off');
  assert.equal(!!ruleStyle([{ ...rule, value: '=1/0' }], 'A1', 'Ana', ctx), false, 'an error colours nothing');
  assert.equal(!!ruleStyle([{ ...rule, value: '=NOPE(' }], 'A1', 'Ana', ctx), false, 'nor does a broken formula');
});

test('colour scales shade each number between the smallest and largest', async () => {
  const { ruleStyle, ruleContext, scaleColour, scaleOf, describeRule } = await import('./condformat.js');
  const { createEvaluator } = await import('./formula.js');
  assert.equal(scaleColour(['#000000', '#ffffff'], 5, 0, 10), '#808080');
  assert.equal(scaleColour(['#ff0000', '#ffffff', '#0000ff'], 0, 0, 10), '#ff0000');
  assert.equal(scaleColour(['#ff0000', '#ffffff', '#0000ff'], 5, 0, 10), '#ffffff');
  assert.equal(scaleColour(['#ff0000', '#ffffff', '#0000ff'], 10, 0, 10), '#0000ff');
  assert.equal(scaleColour(['#000000', '#ffffff'], 3, 3, 3), '#808080', 'all the same: the middle');
  const ev = createEvaluator({ A1: 10, A2: 20, A3: 30, A4: 'n/a', A5: '' });
  const ctx = ruleContext(ev, ev.formulaAt);
  const rule = { id: 's', range: 'A1:A5', when: 'scale', scale: ['#ffffff', '#000000'] };
  assert.deepEqual(ruleStyle([rule], 'A1', 10, ctx), { background: '#ffffff' });
  assert.deepEqual(ruleStyle([rule], 'A3', 30, ctx), { background: '#000000', color: '#ffffff' }, 'light text on a dark shade');
  assert.equal(ruleStyle([rule], 'A2', 20, ctx).background, '#808080');
  assert.equal(ruleStyle([rule], 'A4', 'n/a', ctx), null, 'text is left alone');
  assert.equal(ruleStyle([rule], 'A5', '', ctx), null);
  assert.deepEqual(scaleOf({ scale: ['red', 'x'] }), ['#f8696b', '#ffeb84', '#63be7b'], 'bad colours: the usual scale');
  assert.equal(describeRule({ range: 'B2:B9', when: 'scale', scale: ['#ffffff', '#63be7b'] }), 'B2:B9 · Colour scale: white to green');
});

test('date rules: today, the past, the next and past 7 days, this month, before and after', async () => {
  const { matches, localToday, describeRule } = await import('./condformat.js');
  const today = '2026-11-09';
  const on = (when, v, value) => matches({ when, value }, v, { today });
  assert.deepEqual(['2026-11-09', '2026-11-09 14:30', '2026-11-08', 'soon', 42].map((v) => on('dateToday', v)), [true, true, false, false, false]);
  assert.deepEqual(['2026-11-08', '2025-01-01', '2026-11-09', '2026-11-10'].map((v) => on('datePast', v)), [true, true, false, false], 'overdue');
  assert.deepEqual(['2026-11-09', '2026-11-16', '2026-11-17', '2026-11-08'].map((v) => on('dateNext7', v)), [true, true, false, false]);
  assert.deepEqual(['2026-11-03', '2026-11-02', '2026-11-09', '2026-11-10'].map((v) => on('datePast7', v)), [true, false, true, false]);
  assert.deepEqual(['2026-11-30', '2026-12-01', '2025-11-09'].map((v) => on('dateThisMonth', v)), [true, false, false]);
  assert.deepEqual(['2026-11-30', '2026-12-01', '2026-12-02'].map((v) => on('dateBefore', v, '2026-12-01')), [true, false, false]);
  assert.deepEqual(['2026-11-10', '2026-11-09'].map((v) => on('dateAfter', v, 'TODAY')), [true, false], '"today" moves with the day');
  assert.equal(on('dateBefore', '2026-02-30', '2026-12-01'), false, 'not a real date');
  assert.equal(on('dateBefore', '2026-11-01', 'next week'), false, 'a rule date that isn\'t one matches nothing');
  assert.equal(localToday(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(describeRule({ range: 'D2:D50', when: 'dateBefore', value: 'today' }), 'D2:D50 · Date is before today');
});

test('data bars: a bar as long as the number, from 0 to the largest', async () => {
  const { ruleStyle, ruleContext, barLength, describeRule } = await import('./condformat.js');
  const { createEvaluator } = await import('./formula.js');
  assert.equal(barLength(50, 10, 100), 50);
  assert.equal(barLength(100, 10, 100), 100);
  assert.equal(barLength(0, 0, 100), 2, 'always a sliver');
  assert.equal(barLength(-5, -10, 10), 25, 'negatives: from the smallest');
  assert.equal(barLength(7, 7, 7), 100);
  const ev = createEvaluator({ A1: 25, A2: 100, A3: 'x' });
  const ctx = ruleContext(ev, ev.formulaAt);
  const rule = { id: 'b', range: 'A1:A3', when: 'bars', bar: '#63be7b' };
  assert.deepEqual(ruleStyle([rule], 'A1', 25, ctx), { backgroundImage: 'linear-gradient(to right, #63be7baa 25%, transparent 25%)' });
  assert.equal(ruleStyle([rule], 'A3', 'x', ctx), null);
  assert.equal(describeRule(rule), 'A1:A3 · Data bars: green');
});
