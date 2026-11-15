import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasFilter, toggleFilter, markWords, inFilter } from './searchfilters.js';

test('filters go on and come off', () => {
  assert.equal(toggleFilter('budget', 'from:me'), 'budget from:me');
  assert.equal(toggleFilter('budget From:Me', 'from:me'), 'budget');
  assert.equal(toggleFilter('', 'has:file'), 'has:file');
  assert.equal(toggleFilter('"next quarter" in:"Ann Lee"', 'is:thread'), '"next quarter" in:"Ann Lee" is:thread', 'phrases kept whole');
  assert.equal(hasFilter('budget has:link', 'has:link'), true);
  assert.equal(hasFilter('budget has:links', 'has:link'), false);
});

test('only the words searched for are marked', () => {
  assert.equal(markWords('budget "next quarter" from:kim -draft in:"Ann Lee"'), 'budget next quarter');
});

test('the filter for a conversation', () => {
  assert.equal(inFilter({ name: 'launch' }), 'in:#launch');
  assert.equal(inFilter({ dm_key: 'a:b' }, 'Ann Lee'), 'in:"Ann Lee"');
  assert.equal(inFilter({ dm_key: 'a:b' }), null);
  assert.equal(inFilter(null), null);
});
