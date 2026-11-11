import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTheme, themeOf, FORM_COLORS } from '../src/formtheme.js';

test('cleanTheme keeps only known colours, fonts and backgrounds, and a picture id', () => {
  assert.equal(cleanTheme(null), null);
  assert.equal(cleanTheme([]), null);
  assert.equal(cleanTheme({}), null);
  assert.deepEqual(cleanTheme({ color: 'blue' }), { color: 'blue' });
  assert.equal(cleanTheme({ color: 'toString' }), null, 'not an inherited property name');
  assert.equal(cleanTheme({ color: 'red; background:url(x)' }), null);
  assert.equal(cleanTheme({ font: 'basic', background: 'plain' }), null, 'the defaults need no keeping');
  assert.deepEqual(cleanTheme({ font: 'decorative', background: 'tinted' }), { font: 'decorative', background: 'tinted' });
  assert.equal(cleanTheme({ font: 'Comic Sans' }), null);
  assert.deepEqual(cleanTheme({ header: 'abc-123', header_alt: 'x'.repeat(400) }), { header: 'abc-123', header_alt: 'x'.repeat(300) });
  assert.equal(cleanTheme({ header: '../../etc' }), null);
  assert.equal(cleanTheme({ header_alt: 'no picture' }), null, 'a description needs a picture');
  for (const c of Object.values(FORM_COLORS)) assert.match(c, /^#[0-9a-f]{6}$/);
});

test('themeOf reads the stored JSON, tolerating bad values', () => {
  assert.equal(themeOf({ theme: null }), null);
  assert.equal(themeOf({ theme: '{bad' }), null);
  assert.deepEqual(themeOf({ theme: '{"color":"green","x":1}' }), { color: 'green' });
});
