import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNumber, mergeFormat, cellStyle, decimals } from './cellformat.js';

const sp = (s) => s.replace(/[  ]/g, ' ');
test('number formats show the value without changing it', () => {
  assert.equal(formatNumber(1234.5, { num: 'number' }, 'en-US'), '1,234.50');
  assert.equal(formatNumber(1234.5, { num: 'number', dp: 0 }, 'en-US'), '1,235');
  assert.equal(sp(formatNumber(1234.5, { num: 'currency', cur: 'MYR' }, 'en-MY')), 'RM 1,234.50');
  assert.equal(formatNumber(1234.5, { num: 'currency', cur: 'USD' }, 'en-US'), '$1,234.50');
  assert.equal(formatNumber(1234.5, { num: 'currency', cur: 'JPY' }, 'en-US'), '¥1,235', 'yen has no decimals');
  assert.equal(formatNumber(0.125, { num: 'percent' }, 'en-US'), '13%');
  assert.equal(formatNumber(0.125, { num: 'percent', dp: 1 }, 'en-US'), '12.5%');
  assert.equal(formatNumber(-3, { num: 'number' }, 'en-US'), '-3.00');
  assert.equal(formatNumber('text', { num: 'number' }), null);
  assert.equal(formatNumber(5, {}), null, 'automatic');
  assert.equal(decimals({ num: 'currency', cur: 'USD' }), 2);
});

test('merging formats: toggles, removal, checks', () => {
  assert.deepEqual(mergeFormat(null, { b: true, color: '#c5221f' }), { b: 1, color: '#c5221f' });
  assert.equal(mergeFormat({ b: 1 }, { b: false }), null, 'nothing left');
  assert.deepEqual(mergeFormat({ num: 'currency', cur: 'USD', dp: 2 }, { num: '' }), null, 'decimals and currency go with the number format');
  assert.deepEqual(mergeFormat({}, { color: 'red; background:url(x)', align: 'justify', evil: 1 }), null, 'only known, valid values');
  assert.deepEqual(mergeFormat({ num: 'number' }, { dp: 14 }), { num: 'number', dp: 10 });
  assert.deepEqual(cellStyle({ b: 1, i: 1, fill: '#fff2cc', align: 'center' }), { fontWeight: 700, fontStyle: 'italic', background: '#fff2cc', textAlign: 'center' });
});

test('strikethrough, wrapping and borders', async () => {
  const { borderFor, cellStyle, mergeFormat } = await import('./cellformat.js');
  assert.deepEqual(mergeFormat(null, { s: true, wrap: true, bd: 'rbtx' }), { s: 1, wrap: 1, bd: 'tbr' });
  assert.equal(mergeFormat({ bd: 't' }, { bd: '' }), null);
  const st = cellStyle({ u: 1, s: 1, wrap: 1, bd: 'tl' });
  assert.equal(st.textDecoration, 'underline line-through');
  assert.equal(st.whiteSpace, 'pre-wrap');
  assert.ok(st.borderTop && st.borderLeft && !st.borderBottom && !st.borderRight);
  const range = { r1: 0, r2: 2, c1: 0, c2: 1 };
  assert.equal(borderFor('outer', range, 0, 0), 'tl');
  assert.equal(borderFor('outer', range, 1, 2), 'br');
  assert.equal(borderFor('outer', range, 0, 1, 'b'), 'bl');
  assert.equal(borderFor('outer', { r1: 3, r2: 3, c1: 3, c2: 3 }, 3, 3), 'tblr');
  assert.equal(borderFor('bottom', range, 1, 1), '');
  assert.equal(borderFor('bottom', range, 1, 2, 't'), 'tb');
  assert.equal(borderFor('all', range, 1, 1), 'tblr');
  assert.equal(borderFor('none', range, 1, 1, 'tb'), '');
});
