import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeList } from '../src/listmerge.js';

const q = (id, title) => ({ id, title });
const base = [q('a', 'Name'), q('b', 'Team'), q('c', 'Lunch')];
const titles = (l) => l.map((x) => `${x.id}:${x.title}`).join(' ');

test('different items changed in each place: both kept', () => {
  const mine = [q('a', 'Full name'), q('b', 'Team'), q('c', 'Lunch')];
  const theirs = [q('a', 'Name'), q('b', 'Team or department'), q('c', 'Lunch')];
  assert.equal(titles(mergeList(base, mine, theirs)), 'a:Full name b:Team or department c:Lunch');
});
test('the same item changed in both: this editor’s change wins', () => {
  assert.equal(titles(mergeList(base, [q('a', 'Mine'), base[1], base[2]], [q('a', 'Theirs'), base[1], base[2]])), 'a:Mine b:Team c:Lunch');
});
test('added elsewhere, added here: both kept, each after the item it follows', () => {
  const mine = [base[0], q('m', 'Mine new'), base[1], base[2]];
  const theirs = [...base, q('t', 'Theirs new')];
  assert.equal(titles(mergeList(base, mine, theirs)), 'a:Name m:Mine new b:Team c:Lunch t:Theirs new');
});
test('deleted elsewhere and not changed here: gone; deleted here: gone', () => {
  assert.equal(titles(mergeList(base, base, [base[0], base[2]])), 'a:Name c:Lunch');
  assert.equal(titles(mergeList(base, [base[0], base[2]], base)), 'a:Name c:Lunch');
});
test('deleted elsewhere but changed here: kept (and the other way round)', () => {
  assert.equal(titles(mergeList(base, [base[0], q('b', 'Team!'), base[2]], [base[0], base[2]])), 'a:Name b:Team! c:Lunch');
  assert.equal(titles(mergeList(base, [base[0], base[2]], [base[0], q('b', 'Team?'), base[2]])), 'a:Name b:Team? c:Lunch');
});
test('moved here: this order; moved elsewhere: that order', () => {
  assert.equal(titles(mergeList(base, [base[2], base[0], base[1]], [base[0], q('b', 'Team 2'), base[2]])), 'c:Lunch a:Name b:Team 2');
  assert.equal(titles(mergeList(base, [q('a', 'Name 2'), base[1], base[2]], [base[1], base[0], base[2]])), 'b:Team a:Name 2 c:Lunch');
});
test('nothing changed elsewhere: exactly what this editor has', () => {
  const mine = [q('c', 'Lunch?'), q('n', 'New'), base[0]];
  assert.deepEqual(mergeList(base, mine, base), mine);
});
