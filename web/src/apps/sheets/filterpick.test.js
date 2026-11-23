import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foundValues, tickFound, untickFound, onlyFound } from './filterpick.js';

const values = ['Zoë', 'Zoe Ltd', 'Ann', ''].map((label) => ({ label, count: 1 }));
const labels = (l) => [...l].map((v) => v.label ?? v);

test('a search leaves accents and case aside, and finds the blanks by their name', () => {
  assert.deepEqual(labels(foundValues(values, 'zoe')), ['Zoë', 'Zoe Ltd']);
  assert.deepEqual(labels(foundValues(values, ' ZOË ')), ['Zoë', 'Zoe Ltd']);
  assert.deepEqual(labels(foundValues(values, 'blank')), ['']);
  assert.equal(foundValues(values, '').length, 4);
});

test('Select all and Clear cover everything when nothing is searched', () => {
  assert.deepEqual(labels(tickFound(new Set(), values, '')), ['Zoë', 'Zoe Ltd', 'Ann', '']);
  assert.deepEqual(labels(untickFound(new Set(['Ann']), values, '')), []);
});

test('while searching they change the found values only', () => {
  assert.deepEqual(labels(tickFound(new Set(['Ann']), values, 'zoe')), ['Ann', 'Zoë', 'Zoe Ltd']);
  assert.deepEqual(labels(untickFound(new Set(['Ann', 'Zoë', 'Zoe Ltd']), values, 'zoe')), ['Ann']);
});

test('Only these keeps just what was found', () => {
  assert.deepEqual(labels(onlyFound(values, 'zoe')), ['Zoë', 'Zoe Ltd']);
});
