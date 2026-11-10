import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printPages, isPortrait, PRINT_LAYOUTS } from './printlayout.js';

const slides = [{ id: 'a' }, { id: 'b', skip: true }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }, { id: 'g' }, { id: 'h' }];
const ids = (pages) => pages.map((p) => p.map((x) => `${x.slide.id}${x.number}`).join(' '));

test('print layouts: slides per page, numbers as in the presentation, skipped slides left out unless asked', () => {
  assert.deepEqual(ids(printPages(slides, { layout: 'slides' })), ['a1', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8']);
  assert.deepEqual(ids(printPages(slides, { layout: 'h3' })), ['a1 c3 d4', 'e5 f6 g7', 'h8']);
  assert.deepEqual(ids(printPages(slides, { layout: 'h6', skipHidden: false })), ['a1 b2 c3 d4 e5 f6', 'g7 h8']);
  assert.deepEqual(ids(printPages(slides, { layout: 'h2' })), ['a1 c3', 'd4 e5', 'f6 g7', 'h8']);
  assert.equal(printPages(slides, { layout: 'notes' }).length, 7);
  assert.deepEqual(printPages([], { layout: 'h6' }), []);
  assert.equal(isPortrait('slides'), false);
  assert.equal(isPortrait('h6'), true);
  assert.deepEqual(PRINT_LAYOUTS.map(([k]) => k), ['slides', 'notes', 'h2', 'h3', 'h6']);
});
