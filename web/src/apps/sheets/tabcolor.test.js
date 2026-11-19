import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAB_COLOURS, tabColorOf, tabColorName } from './tabcolor.js';

test('a tab colour is kept as #rrggbb in lower case; anything else is none', () => {
  assert.equal(tabColorOf('#E53935'), '#e53935');
  assert.equal(tabColorOf('1e88e5'), '#1e88e5');
  for (const bad of ['', null, undefined, 'red', '#fff', '#12345g', 'url(x)']) assert.equal(tabColorOf(bad), undefined, String(bad));
});

test('the colours offered have names; others are named by their value', () => {
  assert.equal(new Set(TAB_COLOURS.map(([c]) => c)).size, TAB_COLOURS.length);
  for (const [c] of TAB_COLOURS) assert.equal(tabColorOf(c), c);
  assert.equal(tabColorName('#E53935'), 'Red');
  assert.equal(tabColorName('#123456'), '#123456');
  assert.equal(tabColorName(''), '');
});
