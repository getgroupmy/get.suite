import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeInHash, placeLink } from './placelink.js';

test('a link to a slide or a sheet, and reading it back', () => {
  const url = placeLink('https://w.example', '/sheets/abc', 'sheet', 'Q3 & Q4 / plan');
  assert.equal(url, 'https://w.example/sheets/abc#sheet=Q3%20%26%20Q4%20%2F%20plan');
  assert.equal(placeInHash(new URL(url).hash, 'sheet'), 'Q3 & Q4 / plan');
  assert.equal(placeInHash('#slide=k3Xa_9', 'slide'), 'k3Xa_9');
  assert.equal(placeInHash('#slide=k3Xa_9', 'sheet'), null, 'another kind of place');
  assert.equal(placeInHash('', 'slide'), null);
  assert.equal(placeInHash('#sheet=%E0%A4', 'sheet'), null, 'broken encoding');
});
