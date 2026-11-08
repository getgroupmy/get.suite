import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSymbols, SYMBOL_GROUPS } from './symbols.js';

test('special characters: found by the start of their names’ words, or by themselves', () => {
  assert.deepEqual(findSymbols('em').map((s) => s.ch), ['—']);
  assert.ok(findSymbols('euro').some((s) => s.ch === '€'));
  const arrows = findSymbols('right arr');
  assert.ok(arrows.length >= 3 && arrows.every((s) => /\bright\b/.test(s.name) && /\barrow\b/.test(s.name)));
  assert.ok(arrows.some((s) => s.ch === '→'));
  assert.deepEqual(findSymbols('©').map((s) => s.name), ['copyright']);
  assert.equal(findSymbols('').length, SYMBOL_GROUPS.reduce((n, [, l]) => n + l.length, 0));
  assert.equal(findSymbols('zzz').length, 0);
  assert.equal(new Set(findSymbols('').map((s) => s.ch)).size, findSymbols('').length, 'no repeats');
});
