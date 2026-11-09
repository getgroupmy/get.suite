import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCode, cleanCode } from './numfmt.js';

const f = (v, code) => formatCode(v, code)?.text ?? null;

test('numbers: placeholders, thousands, decimals, percent, scaling, scientific', () => {
  assert.equal(f(1234.5, '#,##0'), '1,235');
  assert.equal(f(1234.5, '#,##0.00'), '1,234.50');
  assert.equal(f(0.5, '0.00'), '0.50');
  assert.equal(f(0.5, '#.##'), '.5');
  assert.equal(f(7, '000'), '007');
  assert.equal(f(1234567, '#,##0'), '1,234,567');
  assert.equal(f(0.125, '0.0%'), '12.5%');
  assert.equal(f(2500000, '0.0,,"M"'), '2.5M');
  assert.equal(f(12345, '0,"K"'), '12K');
  assert.equal(f(12345, '0.00E+00'), '1.23E+04');
  assert.equal(f(0.00012, '0.0E+00'), '1.2E-04');
  assert.equal(f(-1234.5, '#,##0.00'), '-1,234.50', 'one section: a minus sign');
  assert.equal(f(5, '0 "items"'), '5 items');
  assert.equal(f(5, '\\£0'), '£5');
  assert.equal(f(1.5, '0.0_)'), '1.5 ');
});

test('sections, colours and conditions', () => {
  assert.deepEqual(formatCode(-1234, '#,##0;[Red]-#,##0'), { text: '-1,234', colour: '#d93025' });
  assert.deepEqual(formatCode(1234, '#,##0;[Red]-#,##0'), { text: '1,234', colour: null });
  assert.equal(f(-50, '#,##0.00;(#,##0.00)'), '(50.00)');
  assert.equal(f(0, '0;-0;"Nil"'), 'Nil');
  assert.equal(f(-3, '0;-0;"Nil"'), '-3');
  assert.equal(f('abc', '0;-0;0;"Name: "@'), 'Name: abc');
  assert.equal(f('abc', '0.00'), null, 'text without a text section stays as it is');
  assert.deepEqual(formatCode(150, '[Green][>=100]0;[Red][<100]0'), { text: '150', colour: '#188038' });
  assert.deepEqual(formatCode(50, '[Green][>=100]0;[Red][<100]0'), { text: '50', colour: '#d93025' });
  assert.equal(f({ error: '#DIV/0!' }, '0'), null);
  assert.equal(f('', '0'), null);
});

test('dates and times, from date numbers or dates written as text', () => {
  assert.equal(f(46335, 'dd/mm/yyyy'), '09/11/2026');
  assert.equal(f('2026-11-09', 'd mmm yyyy'), '9 Nov 2026');
  assert.equal(f('2026-11-09', 'dddd, d mmmm yy'), 'Monday, 9 November 26');
  assert.equal(f(46335.6041666667, 'hh:mm'), '14:30');
  assert.equal(f(46335.6041666667, 'h:mm AM/PM'), '2:30 PM');
  assert.equal(f('2026-11-09 08:05', 'yyyy-mm-dd hh:mm'), '2026-11-09 08:05');
  assert.equal(f(46335.25, 'mm:ss'), '00:00', 'mm before ss is minutes');
});

test('codes as stored', () => {
  assert.equal(cleanCode('  #,##0\n '), '#,##0');
  assert.equal(cleanCode(''), null);
  assert.equal(cleanCode('0'.repeat(500)).length, 120);
});
