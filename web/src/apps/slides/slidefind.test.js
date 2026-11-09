import test from 'node:test';
import assert from 'node:assert/strict';
import { placesOf, findInDeck, replaceInDeck, contextOf } from './slidefind.js';

const deck = {
  theme: 'light',
  slides: [
    { id: 's1', items: [{ id: 't1', type: 'text', text: 'Sales in 2025' }, { id: 'p1', type: 'image', alt: 'sales chart' }], notes: 'Mention sales twice: sales!' },
    { id: 's2', items: [{ id: 'tb', type: 'table', cells: [['Region', 'Sales'], ['North', '']] }, { id: 't2', type: 'text', text: 'Wholesale figures' }] },
  ],
};

test('places: text boxes, table cells and notes in reading order; empty ones skipped', () => {
  const p = placesOf(deck);
  assert.deepEqual(p.map((x) => [x.slide, x.item, x.cell, x.notes, x.text]), [
    [0, 't1', null, false, 'Sales in 2025'], [0, null, null, true, 'Mention sales twice: sales!'],
    [1, 'tb', [0, 0], false, 'Region'], [1, 'tb', [0, 1], false, 'Sales'], [1, 'tb', [1, 0], false, 'North'], [1, 't2', null, false, 'Wholesale figures'],
  ]);
});

test('find: case, whole words, regular expressions', () => {
  assert.equal(findInDeck(deck, 'sale').matches.length, 5, 'pictures are not searched; "Wholesale" counts');
  assert.equal(findInDeck(deck, 'sale', { wholeWord: true }).matches.length, 0);
  assert.equal(findInDeck(deck, 'sales', { wholeWord: true }).matches.length, 4);
  assert.equal(findInDeck(deck, 'Sales', { matchCase: true }).matches.length, 2);
  const r = findInDeck(deck, '\\d{4}', { regex: true });
  assert.deepEqual(r.matches.map((m) => [m.slide, m.item, m.from, m.to]), [[0, 't1', 9, 13]]);
  assert.match(findInDeck(deck, '(', { regex: true }).error, /valid regular expression/);
  assert.deepEqual(findInDeck(deck, '').matches, []);
  assert.deepEqual(findInDeck(deck, 'x*', { regex: true }).matches, [], 'empty matches find nothing');
});

test('replace: all, one, in cells and notes, with $1; other slides untouched', () => {
  const all = findInDeck(deck, 'sales', { wholeWord: true }).matches;
  const d = replaceInDeck(deck, all, 'revenue');
  assert.equal(d.slides[0].items[0].text, 'revenue in 2025');
  assert.equal(d.slides[0].notes, 'Mention revenue twice: revenue!');
  assert.deepEqual(d.slides[1].items[0].cells, [['Region', 'revenue'], ['North', '']]);
  assert.equal(d.slides[1].items[1].text, 'Wholesale figures');
  assert.equal(d.slides[0].items[1], deck.slides[0].items[1], 'pictures stay as they are');
  assert.equal(deck.slides[0].items[0].text, 'Sales in 2025', 'the original is not changed');

  const one = replaceInDeck(deck, [all[2]], 'turnover');
  assert.equal(one.slides[0].notes, 'Mention sales twice: turnover!');
  assert.equal(one.slides[1], deck.slides[1], 'a slide without matches is the same object');

  const re = findInDeck(deck, '(\\w+) in (\\d+)', { regex: true }).matches;
  assert.equal(replaceInDeck(deck, re, '$2: $1 ($$)', true).slides[0].items[0].text, '2025: Sales ($)');
  const gone = replaceInDeck(deck, findInDeck(deck, 'Mention sales twice: sales!').matches, '');
  assert.equal(gone.slides[0].notes, undefined, 'notes emptied are removed');
});

test('context around a match', () => {
  const m = findInDeck(deck, 'twice').matches[0];
  assert.deepEqual(contextOf(m, 8), { before: '…n sales ', match: 'twice', after: ': sales!' });
});

test('text in shapes is found and replaced; lines without text are not', () => {
  const d = { slides: [{ id: 's', items: [{ id: 'sh', type: 'shape', shape: 'rect', text: 'Sales up' }, { id: 'ln', type: 'shape', shape: 'line' }] }] };
  const m = findInDeck(d, 'sales').matches;
  assert.deepEqual(m.map((x) => x.item), ['sh']);
  assert.equal(replaceInDeck(d, m, 'Revenue').slides[0].items[0].text, 'Revenue up');
  assert.equal(replaceInDeck(d, findInDeck(d, 'Sales up').matches, '').slides[0].items[0].text, undefined, 'a shape left without text has none');
});
