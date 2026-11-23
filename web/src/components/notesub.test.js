import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteSub } from './notesub.js';

const now = new Date(2026, 10, 23, 12).getTime();
const me = 'u1';

test('a note\'s line in search results', () => {
  assert.equal(noteSub({ labels: [], owner: { id: me } }, me, now), '', 'nothing to add');
  assert.equal(noteSub({ labels: ['home', 'shopping'], owner: { id: me } }, me, now), '#home · #shopping');
  assert.equal(noteSub({ labels: [], items: [{ done: true }, { done: false }, { done: true }], owner: { id: me } }, me, now), '2 of 3 ticked');
  assert.equal(noteSub({ labels: [], remind_at: new Date(2026, 10, 28, 9).getTime(), owner: { id: me } }, me, now), '🔔 28 Nov');
  assert.equal(noteSub({ labels: [], remind_at: new Date(2026, 10, 28, 9).getTime(), remind_repeat: 'weekly', owner: { id: me } }, me, now), '🔔 28 Nov 🔁');
  assert.equal(noteSub({ labels: [], remind_at: now - 1000, owner: { id: me } }, me, now), '', 'a reminder gone by isn\'t shown');
  assert.equal(noteSub({ labels: ['trip'], items: [], archived: true, owner: { id: 'u2', name: 'Kim Park' } }, me, now), '#trip · Archived · from Kim Park');
});
