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
