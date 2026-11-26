import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteFits, noteFilterOf } from '../src/notefilter.js';

const note = (x) => ({ title: '', body: '', items: null, pictures: [], recordings: [], remind_at: null, color: null, ...x });

test('kinds of note', () => {
  assert.equal(noteFits(note({ items: [{ text: 'milk' }] }), { type: 'list' }), true);
  assert.equal(noteFits(note({}), { type: 'list' }), false);
  assert.equal(noteFits(note({ pictures: ['p1'] }), { type: 'picture' }), true);
  assert.equal(noteFits(note({ recordings: [{ id: 'r' }] }), { type: 'voice' }), true);
  assert.equal(noteFits(note({ remind_at: 1 }), { type: 'reminder' }), true);
  assert.equal(noteFits(note({ body: 'see https://example.com' }), { type: 'link' }), true);
  assert.equal(noteFits(note({ items: [{ text: 'http://a.io/x' }] }), { type: 'link' }), true, 'in a checklist');
  assert.equal(noteFits(note({ body: 'https:// nothing' }), { type: 'link' }), false);
  assert.equal(noteFits(note({ comments: 2 }), { type: 'comment' }), true);
  assert.equal(noteFits(note({ comments: 0 }), { type: 'comment' }), false);
  assert.equal(noteFits(note({}), { type: 'comment' }), false);
  assert.equal(noteFits(note({}), {}), true);
});

test('colours', () => {
  assert.equal(noteFits(note({ color: '#FFF8B8' }), { color: '#fff8b8' }), true);
  assert.equal(noteFits(note({ color: '#e2f6d3' }), { color: '#fff8b8' }), false);
  assert.equal(noteFits(note({}), { color: 'none' }), true);
  assert.equal(noteFits(note({ color: '#e2f6d3' }), { color: 'none' }), false);
  assert.equal(noteFits(note({ color: '#e2f6d3', items: [] }), { color: '#e2f6d3', type: 'list' }), true, 'both');
});

test('what the request asks for', () => {
  assert.deepEqual(noteFilterOf({ type: 'list', color: '#abcdef' }), { type: 'list', color: '#abcdef' });
  assert.deepEqual(noteFilterOf({}), { type: null, color: null });
  assert.match(noteFilterOf({ type: 'video' }).error, /type can be/);
  assert.equal(noteFilterOf({ type: 'daily' }).type, 'daily');
  assert.equal(noteFits({ title: 'x', body: '', daily_date: '2026-11-17' }, { type: 'daily' }), true);
  assert.equal(noteFits({ title: 'x', body: '' }, { type: 'daily' }), false);
  assert.match(noteFilterOf({ color: 'red' }).error, /color is/);
});
