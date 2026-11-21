import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textFromDeck } from '../src/office/slidetext.js';

test('a presentation as plain text: titles, words in reading order, tables, charts, pictures, notes, skipped slides', () => {
  const deck = { slides: [
    { id: 'a', notes: '  Say hello\nThen pause ', items: [
      { id: 'r', type: 'text', x: 60, y: 40, w: 30, h: 10, text: 'Right' },
      { id: 'l', type: 'text', x: 5, y: 41, w: 30, h: 10, text: 'Left' },
      { id: 'top', type: 'shape', shape: 'star', x: 50, y: 20, w: 10, h: 10, text: 'Star words' },
      { id: 't', type: 'text', role: 'title', x: 5, y: 5, w: 90, h: 10, text: 'Quarterly\nreview' },
      { id: 'e', type: 'text', x: 5, y: 90, w: 30, h: 5, text: '   ' },
      { id: 'p', type: 'image', fileId: 'x', x: 5, y: 95, w: 10, h: 5, alt: 'Logo' },
      { id: 'q', type: 'image', fileId: 'y', x: 5, y: 96, w: 10, h: 5 },
    ] },
    { id: 'b', skip: true, items: [{ id: 'c', type: 'chart', chartType: 'column', title: 'Sales', data: { categories: ['Jan'], series: [{ name: 'EU', values: [3] }] }, x: 0, y: 0, w: 50, h: 50 }] },
    { id: 'c', items: [] },
  ] };
  assert.equal(textFromDeck(deck), [
    'Slide 1: Quarterly review\n\nStar words\n\nLeft\n\nRight\n\n[Logo]\n\nNotes: Say hello\nThen pause',
    'Slide 2 (skipped)\n\nSales\n\tEU\nJan\t3',
    'Slide 3',
  ].join('\n\n\n') + '\n');
  assert.equal(textFromDeck({}), '\n');
});

test('a list box reads as it shows: each point with its bullet or number, points under others indented', () => {
  const deck = { slides: [{ items: [
    { type: 'text', role: 'title', text: 'Plan', x: 6, y: 6 },
    { type: 'text', role: 'body', text: 'Hire\n\tDesigner\n\tEngineer\n\nShip', list: 'lower-roman', x: 6, y: 26 },
    { type: 'text', role: 'body', text: 'Milk\n\tOat', list: 'check', x: 6, y: 60 },
  ] }] };
  assert.equal(textFromDeck(deck), 'Slide 1: Plan\n\ni. Hire\n  i. Designer\n  ii. Engineer\nii. Ship\n\n✓ Milk\n  – Oat\n');
});
