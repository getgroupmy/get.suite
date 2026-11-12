import test from 'node:test';
import assert from 'node:assert/strict';
import { goReader, notAShortcut, GO_WAIT_MS } from './goto.js';

test('go to: G then a letter opens the app; too slow, or an unknown letter, does nothing', () => {
  const read = goReader();
  assert.deepEqual(read('g', 1000), { wait: true });
  assert.deepEqual(read('m', 1500), { to: '/mail' });
  assert.equal(read('m', 1600), null, 'M alone is not ours');
  assert.deepEqual(read('g', 2000), { wait: true });
  assert.equal(read('d', 2000 + GO_WAIT_MS + 1), null, 'too late');
  assert.deepEqual(read('g', 5000), { wait: true });
  assert.equal(read('z', 5100), null);
  assert.equal(read('d', 5200), null, 'the wait ended with the Z');
  assert.deepEqual(read('g', 6000), { wait: true });
  assert.deepEqual(read('D', 6100), { to: '/drive' }, 'Caps Lock is fine');
  assert.equal(read('G', 7000), null, 'Shift+G is not G');
});

test('go to: not while typing or with Ctrl, Alt or ⌘', () => {
  const el = (tag, extra = {}) => ({ tagName: tag, isContentEditable: false, closest: () => null, ...extra });
  assert.equal(notAShortcut({ key: 'g', target: el('BODY') }), false);
  assert.equal(notAShortcut({ key: 'g', target: el('INPUT') }), true);
  assert.equal(notAShortcut({ key: 'g', target: el('DIV', { isContentEditable: true }) }), true);
  assert.equal(notAShortcut({ key: 'g', target: el('DIV', { closest: () => ({}) }) }), true, 'a spreadsheet grid');
  assert.equal(notAShortcut({ key: 'g', ctrlKey: true, target: el('BODY') }), true);
});
