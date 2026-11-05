import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampBox, moveBox, resizeBox, addSlide, duplicateSlide, removeSlide, moveSlide, updateItem, restack, pictureBox, layoutItems } from './slidemath.js';

const r = (b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v * 100) / 100]));
test('boxes stay on the slide', () => {
  assert.deepEqual(clampBox({ x: 95, y: -5, w: 20, h: 1 }), { x: 80, y: 0, w: 20, h: 3 });
  assert.deepEqual(moveBox({ x: 10, y: 10, w: 20, h: 20 }, 100, 5), { x: 80, y: 15, w: 20, h: 20 });
});

test('resizing from each side and corner, and keeping a picture\'s shape', () => {
  const b = { x: 10, y: 10, w: 40, h: 20 };
  assert.deepEqual(resizeBox(b, 'se', 10, 5), { x: 10, y: 10, w: 50, h: 25 });
  assert.deepEqual(resizeBox(b, 'nw', 5, 5), { x: 15, y: 15, w: 35, h: 15 });
  assert.deepEqual(resizeBox(b, 'w', 100, 0), { x: 47, y: 10, w: 3, h: 20 }, 'never smaller than the minimum');
  assert.deepEqual(resizeBox(b, 'e', 100, 0), { x: 10, y: 10, w: 90, h: 20 }, 'never off the slide');
  assert.deepEqual(r(resizeBox(b, 'se', 20, 1, 2)), { x: 10, y: 10, w: 60, h: 30 }, 'shape kept');
  assert.deepEqual(r(resizeBox(b, 'nw', -10, 0, 2)), { x: 0, y: 5, w: 50, h: 25 }, 'opposite corner stays put');
});

test('slide list: add after, duplicate with new ids, remove (never the last), reorder', () => {
  let deck = { theme: 'light', slides: [{ id: 'a', items: layoutItems('title') }] };
  deck = addSlide(deck, 0, 'two');
  assert.deepEqual(deck.slides[1].items.map((i) => i.role), ['title', 'body', 'body']);
  deck = duplicateSlide(deck, 0);
  assert.equal(deck.slides.length, 3);
  assert.notEqual(deck.slides[1].id, 'a');
  assert.notEqual(deck.slides[1].items[0].id, deck.slides[0].items[0].id);
  deck = moveSlide(deck, 2, 0);
  assert.equal(deck.slides[0].items.length, 3);
  assert.equal(moveSlide(deck, 0, -1), deck);
  const one = removeSlide({ slides: [{ id: 'x', items: [{ id: 'i' }] }] }, 0);
  assert.equal(one.slides.length, 1);
  assert.equal(one.slides[0].items.length, 0, 'the last slide is emptied, not removed');
});

test('items: update, restack; pictures fit and keep their shape', () => {
  let deck = { slides: [{ id: 's', items: [{ id: '1', text: 'a' }, { id: '2' }, { id: '3' }] }] };
  deck = updateItem(deck, 0, '1', { text: 'b' });
  assert.equal(deck.slides[0].items[0].text, 'b');
  assert.deepEqual(restack(deck, 0, '1', 1).slides[0].items.map((i) => i.id), ['2', '3', '1']);
  assert.deepEqual(restack(deck, 0, '3', -1).slides[0].items.map((i) => i.id), ['3', '1', '2']);
  assert.deepEqual(r(pictureBox(1600, 900)), { x: 20, y: 20, w: 60, h: 60 }, 'a 16:9 picture');
  const tall = pictureBox(900, 1600);
  assert.equal(Math.round(tall.h), 60);
  assert.ok(tall.w < 20, 'a tall picture is narrow');
});
