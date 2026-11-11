import test from 'node:test';
import assert from 'node:assert/strict';
import { themeStyle, withTheme, colorOf, FORM_COLORS } from './formtheme.js';

test('themeStyle gives the accent, font and tinted page', () => {
  assert.deepEqual(themeStyle(null), {});
  assert.deepEqual(themeStyle({ color: 'teal' }), { '--form-accent': '#00796b', '--accent': '#00796b', '--on-accent': '#fff' });
  assert.equal(themeStyle({ font: 'formal' })['--form-font'], '"Times New Roman", Times, serif');
  assert.equal(themeStyle({ font: 'basic' })['--form-font'], undefined);
  assert.match(themeStyle({ color: 'red', background: 'tinted' })['--form-page'], /#d32f2f 12%/);
  assert.equal(colorOf({ color: 'nope' }), null);
});

test('withTheme merges a change and drops defaults', () => {
  assert.deepEqual(withTheme(null, { color: 'blue' }), { color: 'blue' });
  assert.deepEqual(withTheme({ color: 'blue', font: 'playful' }, { font: 'basic' }), { color: 'blue' });
  assert.equal(withTheme({ color: 'blue' }, { color: null }), null, 'back to plain');
  assert.deepEqual(withTheme({ header: 'p1', header_alt: 'Hi' }, { header: null }), null, 'the description goes with the picture');
});

test('every theme colour carries white text (contrast 4.5:1 or more)', () => {
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  for (const [k, , hex] of FORM_COLORS) assert.ok(1.05 / (lum(hex) + 0.05) >= 4.5, `${k} ${hex}: ${(1.05 / (lum(hex) + 0.05)).toFixed(2)}`);
});
