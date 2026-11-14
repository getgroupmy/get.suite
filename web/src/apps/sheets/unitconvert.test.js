import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertUnits as cv } from './unitconvert.js';

test('CONVERT: distances, masses, volumes, with prefixes', () => {
  assert.equal(cv(1, 'mi', 'km'), 1.609344);
  assert.equal(cv(6, 'ft', 'm'), 1.8288);
  assert.equal(cv(1, 'lbm', 'kg'), 0.45359237);
  assert.equal(cv(1, 'gal', 'l'), 3.785411784);
  assert.equal(cv(500, 'ml', 'cup'), 2.11337641886519);
  assert.equal(cv(1, 'km2', 'm2'), 1000000, 'squared units take the prefix squared');
  assert.equal(cv(1, 'ha', 'm2'), 10000);
  assert.equal(cv(1, 'm3', 'l'), 1000);
  assert.equal(cv(2.5, 'hr', 'mn'), 150);
  assert.equal(cv(1, 'day', 'sec'), 86400);
  assert.equal(cv(100, 'kn', 'mph'), 115.077944802354);
});
test('CONVERT: temperatures, energy, information', () => {
  assert.equal(cv(100, 'C', 'F'), 212);
  assert.equal(cv(-40, 'F', 'C'), -40);
  assert.equal(cv(0, 'C', 'K'), 273.15);
  assert.equal(cv(1, 'kcal', 'J'), 4186.8);
  assert.equal(cv(1, 'kWh', 'J'), 3600000);
  assert.equal(cv(1, 'byte', 'bit'), 8);
  assert.equal(cv(1, 'kibyte', 'byte'), 1024, 'binary prefixes');
  assert.equal(cv(1, 'Mbyte', 'kbyte'), 1000);
  assert.equal(cv(1, 'HP', 'kW'), 0.745699871582270);
});
test('CONVERT: unknown units, different kinds, and case all give nothing', () => {
  assert.equal(cv(1, 'm', 'kg'), null);
  assert.equal(cv(1, 'C', 'm'), null);
  assert.equal(cv(1, 'parsec', 'm'), null);
  assert.equal(cv(1, 'MI', 'km'), null, 'case-sensitive, as in Excel');
  assert.equal(cv(1, 'kft', 'm'), null, 'no prefixes on non-metric units');
  assert.equal(cv(1, 'kibit', 'm'), null);
});
