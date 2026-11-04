import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampRect, fitAspect, moveRect, resizeRect, toPixels, rotatedSize, outputType, editedName, MIN_CROP } from './cropmath.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

test('rectangles stay inside the picture and above the minimum size', () => {
  assert.deepEqual(clampRect({ x: -0.2, y: 0.9, w: 0.5, h: 0.5 }), { x: 0, y: 0.5, w: 0.5, h: 0.5 });
  const tiny = clampRect({ x: 0.5, y: 0.5, w: 0.001, h: 0.001 });
  assert.equal(tiny.w, MIN_CROP);
  assert.equal(tiny.h, MIN_CROP);
});

test('aspect presets fit the largest centred area', () => {
  // 400x200 picture, square crop: 200x200 in the middle -> w = 0.5, h = 1.
  const sq = fitAspect(1, 400, 200);
  near(sq.w, 0.5, 'w'); near(sq.h, 1, 'h'); near(sq.x, 0.25, 'x'); near(sq.y, 0, 'y');
  // 400x400 picture, 16:9: full width, height 225px.
  const wide = fitAspect(16 / 9, 400, 400);
  near(wide.w, 1, 'w'); near(wide.h * 400, 225, 'h px');
  assert.deepEqual(fitAspect(null, 10, 10), { x: 0, y: 0, w: 1, h: 1 });
});

test('moving stops at the edges', () => {
  assert.deepEqual(moveRect({ x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, 0.5, -0.9), { x: 0.6, y: 0, w: 0.4, h: 0.4 });
});

test('resizing a corner keeps the opposite corner; free and fixed aspect', () => {
  const r = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
  const free = resizeRect(r, 'se', -0.1, 0.1);
  near(free.x, 0.2, 'x'); near(free.y, 0.2, 'y'); near(free.w, 0.5, 'w'); near(free.h, 0.7, 'h');
  const nw = resizeRect(r, 'nw', 0.1, 0.1);
  near(nw.x + nw.w, 0.8, 'right edge fixed'); near(nw.y + nw.h, 0.8, 'bottom edge fixed');
  // Square on a 400x200 picture: pixel width must equal pixel height.
  const sq = resizeRect({ x: 0.25, y: 0, w: 0.5, h: 1 }, 'se', -0.2, -0.2, 1, 400, 200);
  near(sq.w * 400, sq.h * 200, 'square in pixels');
  near(sq.x, 0.25, 'left fixed'); near(sq.y, 0, 'top fixed');
  // Edges never go past the picture.
  const big = resizeRect(r, 'e', 5, 0);
  near(big.x + big.w, 1, 'clamped at right');
});

test('pixel rectangles, rotated sizes, file types and names', () => {
  assert.deepEqual(toPixels({ x: 0.5, y: 0, w: 0.5, h: 0.5 }, 40, 20), { sx: 20, sy: 0, sw: 20, sh: 10 });
  assert.deepEqual(toPixels({ x: 0.999, y: 0.999, w: 0.001, h: 0.001 }, 10, 10).sw, 1);
  assert.deepEqual(rotatedSize(40, 20, 90), { w: 20, h: 40 });
  assert.deepEqual(rotatedSize(40, 20, 270), { w: 20, h: 40 });
  assert.deepEqual(rotatedSize(40, 20, 180), { w: 40, h: 20 });
  assert.equal(outputType('image/jpeg').type, 'image/jpeg');
  assert.equal(outputType('image/gif').type, 'image/png');
  assert.equal(editedName('holiday.jpeg', 'jpg'), 'holiday (edited).jpg');
  assert.equal(editedName('holiday (edited).jpg', 'jpg'), 'holiday (edited).jpg');
});
