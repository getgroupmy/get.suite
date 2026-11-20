import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeOfMatch } from '../src/matchplace.js';

test('in a presentation: the first slide with all the words (notes and tables too, any case or accents)', () => {
  const deck = { slides: [
    { id: 's1', items: [{ type: 'text', text: 'Welcome' }] },
    { id: 's2', items: [{ type: 'table', cells: [['Budget', '900']] }], notes: 'Mention the café' },
    { id: 's3', items: [{ type: 'text', text: 'Budget again' }] },
  ] };
  assert.deepEqual(placeOfMatch('slides', deck, 'budget cafe'), { hash: '#slide=s2', words: 'Slide 2' }, 'all the words; accents don\'t matter');
  assert.deepEqual(placeOfMatch('slides', deck, 'BUDGET café'), { hash: '#slide=s2', words: 'Slide 2' });
  assert.equal(placeOfMatch('slides', deck, 'budget welcome'), null, 'not split across slides');
  assert.deepEqual(placeOfMatch('slides', deck, 'again'), { hash: '#slide=s3', words: 'Slide 3' });
  assert.equal(placeOfMatch('slides', deck, 'nothing'), null);
});

test('in a spreadsheet: the first cell (row by row) with the first word, not formulas', () => {
  const book = { sheets: [
    { name: 'Intro', cells: { A1: 'Hello' } },
    { name: 'Costs Q3', cells: { C2: 'Rent for May', A10: 'rent total', B2: '=RENT()', A2: 'Office rent' } },
  ] };
  assert.deepEqual(placeOfMatch('sheet', book, 'rent'), { hash: '#sheet=Costs%20Q3&range=A2', words: 'Costs Q3 · A2' });
  assert.equal(placeOfMatch('sheet', book, 'zzz'), null);
  assert.equal(placeOfMatch('doc', {}, 'rent'), null, 'documents: not here');
});
