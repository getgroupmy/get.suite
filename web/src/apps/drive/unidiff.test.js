import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unifiedDiff } from './unidiff.js';

const L = (op, text, a, b) => ({ op, text, a, b });

test('one change in the middle: a hunk with three lines of context each side', () => {
  const lines = [L('=', 'a', 1, 1), L('=', 'b', 2, 2), L('=', 'c', 3, 3), L('=', 'd', 4, 4), L('-', 'e', 5, null), L('+', 'E', null, 5),
    L('=', 'f', 6, 6), L('=', 'g', 7, 7), L('=', 'h', 8, 8), L('=', 'i', 9, 9)];
  assert.equal(unifiedDiff(lines, 'a/x.txt', 'b/x.txt'), '--- a/x.txt\n+++ b/x.txt\n@@ -2,7 +2,7 @@\n b\n c\n d\n-e\n+E\n f\n g\n h\n');
});

test('changes far apart make two hunks; additions at the start and end (as GNU diff -u writes them)', () => {
  const lines = [L('+', 'top', null, 1), ...Array.from({ length: 10 }, (_, i) => L('=', `l${i}`, i + 1, i + 2)), L('+', 'end', null, 12)];
  const d = unifiedDiff(lines, 'old', 'new');
  assert.match(d, /^--- old\n\+\+\+ new\n@@ -1,3 \+1,4 @@\n\+top\n l0\n l1\n l2\n@@ -8,3 \+9,4 @@\n l7\n l8\n l9\n\+end\n$/);
});

test('no differences: nothing to write', () => {
  assert.equal(unifiedDiff([L('=', 'same', 1, 1)], 'a', 'b'), '');
});
