import { test } from 'node:test';
import assert from 'node:assert/strict';

// A stand-in for the page and its storage.
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.document = { documentElement: { dataset: {} } };
const { getA11y, setA11y } = await import('./theme.js');

test('text size, contrast and motion: kept on the device and put on <html>; unknown values mean normal', () => {
  assert.equal(getA11y('textSize'), 'normal');
  assert.equal(setA11y('textSize', 'larger'), 'larger');
  assert.equal(document.documentElement.dataset.textSize, 'larger');
  assert.equal(store.get('nw.textSize'), 'larger');
  assert.equal(getA11y('textSize'), 'larger');
  setA11y('contrast', 'more'); setA11y('motion', 'reduce');
  assert.deepEqual({ ...document.documentElement.dataset }, { textSize: 'larger', contrast: 'more', motion: 'reduce' });
  assert.equal(setA11y('textSize', 'huge'), 'normal', 'not a size: back to normal');
  assert.equal(document.documentElement.dataset.textSize, undefined);
  assert.equal(store.has('nw.textSize'), false);
  store.set('nw.contrast', 'weird');
  assert.equal(getA11y('contrast'), 'normal');
});
