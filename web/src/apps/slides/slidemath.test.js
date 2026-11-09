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

test('presenting passes over skipped slides; slide settings change one slide', async () => {
  const { stepSlide, firstShown, setSlide } = await import('./slidemath.js');
  const deck = { slides: [{ id: 'a' }, { id: 'b', skip: true }, { id: 'c' }, { id: 'd', skip: true }] };
  assert.equal(stepSlide(deck, 0, 1), 2);
  assert.equal(stepSlide(deck, 2, -1), 0);
  assert.equal(stepSlide(deck, 2, 1), 2, 'nothing shown after');
  assert.equal(firstShown(deck, 1), 2);
  assert.equal(firstShown(deck, 3), 3, 'the last one, skipped: shown anyway');
  const next = setSlide(deck, 0, { transition: 'fade', skip: false });
  assert.deepEqual(next.slides[0], { id: 'a', transition: 'fade' });
  assert.deepEqual(setSlide(next, 0, { transition: '' }).slides[0], { id: 'a' });
  assert.equal(deck.slides[0].transition, undefined, 'not changed in place');
});

import { newTable, resizeTable, setCell } from './slidemath.js';
test('tables: new, grow and shrink keeping text, set a cell, limits', () => {
  assert.deepEqual(newTable(2, 3), [['', '', ''], ['', '', '']]);
  const t = setCell(newTable(2, 2), 1, 0, 'x');
  assert.deepEqual(t, [['', ''], ['x', '']]);
  assert.deepEqual(resizeTable(t, 3, 1), [[''], ['x'], ['']]);
  assert.deepEqual(resizeTable(t, 0, 99)[0].length, 10);
  assert.equal(resizeTable(t, 0, 1).length, 1);
});

test('animations: boxes come in one click at a time, in the order they were given one', async () => {
  const { builds, animChange, stepPresent } = await import('./slidemath.js');
  let s = { id: 'a', items: [{ id: 't' }, { id: 'p' }, { id: 'q' }] };
  const set = (id, anim) => { s = { ...s, items: s.items.map((it) => (it.id === id ? Object.fromEntries(Object.entries({ ...it, ...animChange(s, it, anim) }).filter(([, v]) => v !== undefined)) : it)) }; };
  set('q', 'fade'); set('p', 'fly');
  assert.deepEqual(builds(s).map((it) => it.id), ['q', 'p']);
  set('q', 'appear');
  assert.deepEqual(builds(s).map((it) => it.id), ['q', 'p'], 'changing the effect keeps its place');
  set('q', ''); set('q', 'fade');
  assert.deepEqual(builds(s).map((it) => it.id), ['p', 'q'], 'taken out and put back: last');
  const deck = { slides: [s, { id: 'b', skip: true, items: [] }, { id: 'c', items: [{ id: 'x', anim: 'fade', animAt: 1 }] }] };
  let at = { i: 0, b: 0 };
  const seq = [];
  for (let k = 0; k < 6; k++) { at = stepPresent(deck, at, 1); seq.push(`${at.i}.${at.b}`); }
  assert.deepEqual(seq, ['0.1', '0.2', '2.0', '2.1', '2.1', '2.1']);
  assert.deepEqual(stepPresent(deck, { i: 2, b: 0 }, -1), { i: 0, b: 2 }, 'back: the previous slide with everything in');
  assert.deepEqual(stepPresent(deck, { i: 2, b: 1 }, -1), { i: 2, b: 0 });
});

test('presentation changes: slides added, deleted, moved, and what changed on each', async () => {
  const { slideChanges } = await import('./slidemath.js');
  const t = (id, text, role) => ({ id, type: 'text', text, ...(role && { role }) });
  const before = { slides: [
    { id: 'a', items: [t('a1', 'Welcome', 'title'), t('a2', 'Old words')] },
    { id: 'b', items: [t('b1', 'Plan', 'title')] },
    { id: 'c', items: [t('c1', 'Gone', 'title')] },
    { id: 'd', items: [t('d1', 'Same', 'title'), { id: 'd2', type: 'shape', fill: 'accent' }] },
  ] };
  const after = { slides: [
    { id: 'b', items: [t('b1', 'Plan', 'title')] },
    { id: 'a', items: [t('a1', 'Welcome', 'title'), t('a2', 'New words'), { id: 'a3', type: 'image', fileId: 'f' }], notes: 'Say hi' },
    { id: 'd', items: [t('d1', 'Same', 'title'), { id: 'd2', type: 'shape', fill: 'text' }], transition: 'fade' },
    { id: 'e', items: [t('e1', 'Fresh', 'title')] },
  ] };
  const ch = slideChanges(before, after);
  assert.deepEqual(ch.map((c) => `${c.n}:${c.status}:${c.title}`), ['1:moved:Plan', '2:changed:Welcome', '3:changed:Same', '4:added:Fresh', '3:removed:Gone']);
  assert.deepEqual(ch[1].details, [
    { kind: 'edit', what: 'text box', was: 'Old words', now: 'New words' },
    { kind: 'add', what: 'picture', now: '' },
    { kind: 'edit', what: 'speaker notes', was: '', now: 'Say hi' },
  ]);
  assert.deepEqual(ch[2].details.map((d) => `${d.kind} ${d.what}`), ['look shape', 'look transition']);
  assert.deepEqual(slideChanges(after, after), []);
});

test('moving, copying and deleting several slides at once', async () => {
  const { moveSlides, duplicateSlides, removeSlides } = await import('./slidemath.js');
  const deck = { theme: 'light', slides: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, items: [{ id: `${id}1`, type: 'text', text: id }] })) };
  const ids = (d) => d.slides.map((s) => s.id).join('');
  let r = moveSlides(deck, [1, 3], 5);
  assert.equal(ids(r.deck), 'acebd'); assert.equal(r.first, 3);
  r = moveSlides(deck, [3, 4], 0);
  assert.equal(ids(r.deck), 'deabc'); assert.equal(r.first, 0);
  r = moveSlides(deck, [2], 3);
  assert.equal(r.deck, deck, 'dropped where it was'); assert.equal(r.first, 2);
  r = moveSlides(deck, [0], 2);
  assert.equal(ids(r.deck), 'bacde'); assert.equal(r.first, 1);
  const dup = duplicateSlides(deck, [3, 1]);
  assert.equal(dup.slides.length, 7);
  assert.equal(dup.slides.slice(0, 4).map((s) => s.id).join(''), 'abcd');
  assert.equal(dup.slides[4].items[0].text, 'b'); assert.equal(dup.slides[5].items[0].text, 'd');
  assert.notEqual(dup.slides[4].id, 'b'); assert.notEqual(dup.slides[4].items[0].id, 'b1');
  assert.equal(ids(removeSlides(deck, [0, 4])), 'bcd');
  assert.equal(removeSlides(deck, [0, 1, 2, 3, 4]).slides.length, 1);
});

import { nextPresent, advanceLabel } from './slidemath.js';
test('presenting on: past the last slide only when the presentation loops, to the first shown slide', () => {
  const deck = { slides: [{ id: 'a', items: [], skip: true }, { id: 'b', items: [] }, { id: 'c', items: [] }] };
  assert.deepEqual(nextPresent(deck, { i: 1, b: 0 }), { i: 2, b: 0 });
  const end = { i: 2, b: 0 };
  assert.equal(nextPresent(deck, end), end, 'stays on the last one');
  assert.deepEqual(nextPresent({ ...deck, loop: true }, end), { i: 1, b: 0 }, 'loops, passing over the skipped first slide');
  assert.equal(advanceLabel(0), 'Never');
  assert.equal(advanceLabel(15), 'After 15 seconds');
  assert.equal(advanceLabel(60), 'After 1 minute');
});

test('smart guides: snapping to the slide centre and to other boxes', async () => {
  const { snapBox } = await import('./slidemath.js');
  // Centred on the slide: 39.5 + 20/2 = 49.5, within 1.2 of 50.
  let r = snapBox({ x: 39.5, y: 10.4, w: 20, h: 10 }, []);
  assert.equal(r.box.x, 40);
  assert.equal(r.box.y, 10.4, 'nothing near on y');
  assert.deepEqual(r.guides, [{ axis: 'x', at: 50 }]);
  // Left edge to another box's left edge, top to its bottom.
  r = snapBox({ x: 10.8, y: 41, w: 20, h: 10 }, [{ x: 10, y: 20, w: 30, h: 20.5 }]);
  assert.equal(r.box.x, 10);
  assert.equal(r.box.y, 40.5);
  assert.ok(r.guides.some((g) => g.axis === 'x' && g.at === 10));
  assert.ok(r.guides.some((g) => g.axis === 'y' && g.at === 40.5));
  // Too far: unchanged, no guides.
  r = snapBox({ x: 20, y: 20, w: 10, h: 10 }, [{ x: 60, y: 60, w: 10, h: 10 }]);
  assert.deepEqual([r.box.x, r.box.y, r.guides.length], [20, 20, 0]);
  // Right edge to the slide's edge.
  r = snapBox({ x: 69, y: 5, w: 30, h: 10 }, []);
  assert.equal(r.box.x, 70);
});
