import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLatest, sameMessages } from './mergelatest.js';

const m = (id, at, body = id) => ({ id, created_at: at, body });

test('missed messages are added in time order; edited ones replace what was shown; older ones stay', () => {
  const shown = [m('a', 1), m('b', 2), m('c', 3, 'old text')];
  const latest = [m('b', 2), m('c', 3, 'edited'), m('d', 4), m('e', 5)];
  const r = mergeLatest(shown, latest);
  assert.deepEqual(r.map((x) => x.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(r[2].body, 'edited');
});

test('nothing missed: the same messages; something still being sent (no time yet) stays at the end', () => {
  const shown = [m('a', 1), m('b', 2)];
  assert.deepEqual(mergeLatest(shown, [m('b', 2)]).map((x) => x.id), ['a', 'b']);
  const sending = { id: 'tmp1', body: 'sending…' };
  assert.deepEqual(mergeLatest([...shown, sending], [m('c', 3)]).map((x) => x.id), ['a', 'b', 'c', 'tmp1']);
  assert.equal(sameMessages(shown, [shown[0], shown[1]]), true);
  assert.equal(sameMessages(shown, mergeLatest(shown, [m('b', 2, 'x')])), false);
});
