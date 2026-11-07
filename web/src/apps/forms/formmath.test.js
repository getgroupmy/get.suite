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
