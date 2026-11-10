import test from 'node:test';
import assert from 'node:assert/strict';
import { nextViewName, cleanViewName, adjustViews, viewSheet, viewList, viewLink } from './views.js';

test('views: the next free name', () => {
  assert.equal(nextViewName(null), 'Filter 1');
  assert.equal(nextViewName({ a: { name: 'Filter 1' }, b: { name: 'filter 3' } }), 'Filter 2');
});

test('views: names are one tidy line', () => {
  assert.equal(cleanViewName('  North \n only  '), 'North only');
  assert.equal(cleanViewName('   '), null);
  assert.equal(cleanViewName('x'.repeat(80)).length, 60);
});

test('views: move with inserted and deleted rows and columns, and go with their headings', () => {
  const views = { a: { name: 'Mine', range: 'A2:C9', hidden: { B: ['Done'] } }, b: { name: 'Top', range: 'A1:C9', hidden: {} } };
  const after = adjustViews(views, { axis: 'col', at: 0, count: 1 });
  assert.deepEqual(after.a, { name: 'Mine', range: 'B2:D9', hidden: { C: ['Done'] } });
  const gone = adjustViews(views, { axis: 'row', at: 1, count: -1 });
  assert.deepEqual(Object.keys(gone), ['b']);
  assert.equal(adjustViews(undefined, { axis: 'row', at: 0, count: 1 }), undefined);
});

test('views: which sheet has one, in name order, and its link', () => {
  const sheets = [{ name: 'A' }, { name: 'B', views: { x: { name: 'b' }, y: { name: 'a' } } }];
  assert.equal(viewSheet(sheets, 'x'), 1);
  assert.equal(viewSheet(sheets, 'z'), -1);
  assert.deepEqual(viewList(sheets[1].views).map(([id]) => id), ['y', 'x']);
  assert.equal(viewLink('https://w.example', 'f1', 'x y'), 'https://w.example/sheets/f1?fv=x%20y');
});
