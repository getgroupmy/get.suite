import { test } from 'node:test';
import assert from 'node:assert/strict';
import { squareCrop, photoUrl } from './photo.js';

test('the middle square, at most 256 across', () => {
  assert.deepEqual(squareCrop(1000, 600), { sx: 200, sy: 0, s: 600, out: 256 });
  assert.deepEqual(squareCrop(300, 900), { sx: 0, sy: 300, s: 300, out: 256 });
  assert.deepEqual(squareCrop(100, 80), { sx: 10, sy: 0, s: 80, out: 80 }, 'small pictures aren\'t blown up');
});

test('the photo address changes when the photo does', () => {
  assert.equal(photoUrl({ id: 'c1', photo_at: 5 }), '/api/contacts/c1/photo?v=5');
  assert.equal(photoUrl({ id: 'c1' }), undefined);
});
