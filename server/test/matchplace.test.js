import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeOfMatch, lineOfMatch } from '../src/matchplace.js';

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
  assert.deepEqual(placeOfMatch('doc', {}, 'Penang trip'), { hash: '#find=Penang', words: null }, 'a document: find its first word');
});

test('in a text file: the first line with all the words, or else with the first of them', () => {
  const text = '# Deploy\nreplicas: 2\nimage: shop\n\nCafé replicas for the shop\n';
  assert.deepEqual(lineOfMatch(text, 'replicas'), { line: 2, words: 'Line 2' });
  assert.deepEqual(lineOfMatch(text, 'shop replicas'), { line: 5, words: 'Line 5' }, 'all the words on one line wins');
  assert.deepEqual(lineOfMatch(text, 'CAFE'), { line: 5, words: 'Line 5' }, 'any case, accents left out');
  assert.deepEqual(lineOfMatch(text, 'image deploy'), { line: 3, words: 'Line 3' }, 'on no one line: where the first word is');
  assert.equal(lineOfMatch(text, 'nothing'), null);
  assert.equal(lineOfMatch(text, '  '), null);
  assert.deepEqual(lineOfMatch(`${'x\n'.repeat(1499)}needle`, 'needle'), { line: 1500, words: 'Line 1,500' });
});
