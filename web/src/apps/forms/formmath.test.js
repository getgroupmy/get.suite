import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retype, nextOption, summarize, percent } from './formmath.js';

test('retype keeps the title and fitting parts', () => {
  const q = { id: 'a', type: 'choice', title: 'Lunch', required: true, options: ['Fish', 'Veg'] };
  assert.deepEqual(retype(q, 'checkbox'), { id: 'a', type: 'checkbox', title: 'Lunch', required: true, options: ['Fish', 'Veg'] });
  assert.deepEqual(retype(q, 'short'), { id: 'a', type: 'short', title: 'Lunch', required: true });
  assert.deepEqual(retype(q, 'scale'), { id: 'a', type: 'scale', title: 'Lunch', required: true, max: 5, low: '', high: '' });
  assert.deepEqual(retype({ id: 'b', type: 'short', title: '' }, 'dropdown').options, ['Option 1']);
});

test('nextOption skips names in use', () => {
  assert.equal(nextOption(['Option 1']), 'Option 2');
  assert.equal(nextOption(['Option 1', 'Option 3']), 'Option 4');
});

test('summarize counts choices, scales and lists text', () => {
  const qs = [
    { id: 'f', type: 'choice', title: 'Food', options: ['Pizza', 'Sushi'] },
    { id: 'd', type: 'checkbox', title: 'Days', options: ['Mon', 'Tue'] },
    { id: 's', type: 'scale', title: 'Rate', max: 5 },
    { id: 'n', type: 'short', title: 'Note' },
  ];
  const rs = [
    { answers: { f: 'Pizza', d: ['Mon', 'Tue'], s: 4, n: 'first' } },
    { answers: { f: 'Pizza', d: ['Mon'], s: 5 } },
    { answers: { f: 'Sushi', n: 'last' } },
  ];
  const [food, days, rate, note] = summarize(qs, rs);
  assert.equal(food.answered, 3);
  assert.deepEqual(food.bars.map((b) => [b.label, b.count]), [['Pizza', 2], ['Sushi', 1]]);
  assert.equal(percent(food.bars[0].share), '67%');
  assert.equal(days.answered, 2);
  assert.deepEqual(days.bars.map((b) => b.count), [2, 1], 'tick boxes count each choice');
  assert.equal(rate.bars.length, 5);
  assert.equal(rate.bars[3].count, 1);
  assert.equal(rate.average, 4.5);
  assert.deepEqual(note.texts, ['last', 'first'], 'newest first');
});

test('file questions: a new one allows one file; the summary lists the files, newest first', async () => {
  const { retype, summarize } = await import('./formmath.js');
  assert.equal(retype({ id: 'a', title: 'CV' }, 'file').max_files, 1);
  const s = summarize([{ id: 'cv', type: 'file', title: 'CV' }], [{ answers: { cv: [{ file_id: '1', name: 'a.pdf' }] } }, { answers: { cv: [{ file_id: '2', name: 'b.pdf' }, { file_id: '3', name: 'c.pdf' }] } }, { answers: {} }]);
  assert.equal(s[0].answered, 2);
  assert.deepEqual(s[0].files.map((f) => f.name), ['b.pdf', 'c.pdf', 'a.pdf']);
});

test('sections: pages, and where an answer leads (only forward)', async () => {
  const { sectionsOf, nextPage, pathOf, summarize } = await import('./formmath.js');
  const qs = [{ id: 'k', type: 'choice', options: ['A', 'B'], goto: { B: 's2' } }, { id: 's1', type: 'section', title: 'One' }, { id: 'x', type: 'short' }, { id: 's2', type: 'section', title: 'Two' }, { id: 'y', type: 'short', goto: { z: 's1' } }];
  const pages = sectionsOf(qs);
  assert.deepEqual(pages.map((p) => p.id), [null, 's1', 's2']);
  assert.equal(nextPage(pages, 0, { k: 'A' }), 1);
  assert.equal(nextPage(pages, 0, { k: 'B' }), 2);
  assert.deepEqual(pathOf(pages, { k: 'B' }), [0, 2]);
  assert.deepEqual(sectionsOf([{ id: 's', type: 'section' }, { id: 'q', type: 'short' }]).map((p) => p.id), ['s'], 'no empty first page');
  assert.equal(summarize(qs, []).length, 3, 'sections are not summarised');
});

test('rankings: kept when every option is there once; summed up by average place', async () => {
  const { prefillFrom, summarize, rankSummary, retype } = await import('./formmath.js');
  const q = { id: 'r', type: 'rank', title: 'Venues', options: ['A', 'B', 'C'] };
  assert.deepEqual(prefillFrom([q], JSON.stringify({ r: ['C', 'A', 'B'] })), { r: ['C', 'A', 'B'] });
  assert.deepEqual(prefillFrom([q], JSON.stringify({ r: ['C', 'A'] })), {});
  const rs = [{ answers: { r: ['A', 'B', 'C'] } }, { answers: { r: ['B', 'A', 'C'] } }, { answers: { r: ['A', 'C', 'B'] } }];
  assert.deepEqual(summarize([q], rs)[0].ranks, [
    { label: 'A', average: 1.3, first: 2 }, { label: 'B', average: 2, first: 1 }, { label: 'C', average: 2.7, first: 0 },
  ]);
  assert.deepEqual(rankSummary(['A', 'B'], []), [{ label: 'A', average: null, first: 0 }, { label: 'B', average: null, first: 0 }]);
  assert.equal(retype({ id: 'x', type: 'choice', options: ['Only'] }, 'rank').options.length, 2, 'two at least');
});
