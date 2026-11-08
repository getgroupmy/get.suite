import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { brokenProtections } from './protect.js';
import { applyStructure } from './structure.js';

test('the web copy of the protection rules matches the server', () => {
  const body = (t) => t.slice(t.indexOf('const REF'));
  assert.equal(body(fs.readFileSync(new URL('./protect.js', import.meta.url), 'utf8')), body(fs.readFileSync(new URL('../../../../server/src/sheetprotect.js', import.meta.url), 'utf8')));
});

test('protected ranges move with inserted rows, and go when all their rows are deleted', () => {
  const sheet = { name: 'S', cells: { A2: '1' }, protected: [{ id: 'a', range: 'A2:B3', editors: [] }, { id: 'w', range: null, editors: [] }] };
  const moved = applyStructure(sheet, { axis: 'row', at: 0, count: 2 });
  assert.deepEqual(moved.protected.map((p) => p.range), ['A4:B5', null]);
  const gone = applyStructure(sheet, { axis: 'row', at: 1, count: -2 });
  assert.deepEqual(gone.protected.map((p) => p.id), ['w']);
  // For someone not allowed, inserting rows above the range is a change to it.
  assert.equal(brokenProtections({ sheets: [sheet] }, { sheets: [moved] }, 'bob', 'owner').length, 2);
});
