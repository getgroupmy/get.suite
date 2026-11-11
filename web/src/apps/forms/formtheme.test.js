import test from 'node:test';
import assert from 'node:assert/strict';
import { themeStyle, withTheme, colorOf } from './formtheme.js';

test('themeStyle gives the accent, font and tinted page', () => {
  assert.deepEqual(themeStyle(null), {});
  assert.deepEqual(themeStyle({ color: 'teal' }), { '--form-accent': '#00897b', '--accent': '#00897b' });
  assert.equal(themeStyle({ font: 'formal' })['--form-font'], '"Times New Roman", Times, serif');
  assert.equal(themeStyle({ font: 'basic' })['--form-font'], undefined);
  assert.match(themeStyle({ color: 'red', background: 'tinted' })['--form-page'], /#e53935 12%/);
  assert.equal(colorOf({ color: 'nope' }), null);
});

test('withTheme merges a change and drops defaults', () => {
  assert.deepEqual(withTheme(null, { color: 'blue' }), { color: 'blue' });
  assert.deepEqual(withTheme({ color: 'blue', font: 'playful' }, { font: 'basic' }), { color: 'blue' });
  assert.equal(withTheme({ color: 'blue' }, { color: null }), null, 'back to plain');
  assert.deepEqual(withTheme({ header: 'p1', header_alt: 'Hi' }, { header: null }), null, 'the description goes with the picture');
});
