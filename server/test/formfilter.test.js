import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesFilter, filterFrom, ANSWERED, BLANK, OTHER } from '../src/formfilter.js';

export const QS = [
  { id: 'where', type: 'choice', options: ['Lisbon', 'Porto'], other: true },
  { id: 'food', type: 'checkbox', options: ['Pizza', 'Sushi'] },
  { id: 'stars', type: 'rating', max: 5 },
  { id: 'order', type: 'rank', options: ['Hike', 'Boat'] },
  { id: 'note', type: 'paragraph' },
  { id: 'g', type: 'grid', rows: ['Mon'], columns: ['Yes'] },
];
export const CASES = [
  [{ where: 'Lisbon' }, { q: 'where', v: 'Lisbon' }, true],
  [{ where: 'Porto' }, { q: 'where', v: 'Lisbon' }, false],
  [{ where: 'Faro' }, { q: 'where', v: OTHER }, true],
  [{ where: 'Porto' }, { q: 'where', v: OTHER }, false],
  [{ food: ['Pizza', 'Sushi'] }, { q: 'food', v: 'Sushi' }, true],
  [{ food: ['Pizza'] }, { q: 'food', v: 'Sushi' }, false],
  [{ stars: 5 }, { q: 'stars', v: '5' }, true],
  [{ stars: 4 }, { q: 'stars', v: '5' }, false],
  [{ order: ['Hike', 'Boat'] }, { q: 'order', v: 'Hike' }, true],
  [{ order: ['Boat', 'Hike'] }, { q: 'order', v: 'Hike' }, false],
  [{ note: 'More SALAD please' }, { q: 'note', v: ' salad ' }, true],
  [{ note: 'Pizza' }, { q: 'note', v: 'salad' }, false],
  [{ g: { Mon: 'Yes' } }, { q: 'g', v: ANSWERED }, true],
  [{ g: {} }, { q: 'g', v: ANSWERED }, false],
  [{}, { q: 'note', v: BLANK }, true],
  [{ note: 'x' }, { q: 'note', v: BLANK }, false],
  [{}, { q: 'where', v: 'Lisbon' }, false],
  [{ where: 'Porto' }, { q: 'gone', v: 'x' }, true], // a question no longer there: no filter
  [{ where: 'Porto' }, null, true],
];

test('filtering responses by an answer', () => {
  for (const [answers, f, want] of CASES) assert.equal(matchesFilter(QS, answers, f), want, JSON.stringify([answers, f]));
  assert.equal(filterFrom({}), null);
  assert.deepEqual(filterFrom({ fq: 'where', fv: 'Lisbon' }), { q: 'where', v: 'Lisbon' });
  assert.deepEqual(filterFrom({ fq: 'note' }), { q: 'note', v: '' });
});
