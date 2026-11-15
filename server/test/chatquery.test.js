import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatQuery, anything } from '../src/chatquery.js';

test('words, phrases and left-out words', () => {
  const p = parseChatQuery('Budget "next quarter" -draft -"old plan"');
  assert.deepEqual(p.words, ['budget']);
  assert.deepEqual(p.phrases, ['next quarter']);
  assert.deepEqual(p.without, ['draft', 'old plan']);
});

test('filters', () => {
  const p = parseChatQuery('from:@Kim from:me in:#Launch in:"Ann Lee" has:files has:picture has:link is:thread');
  assert.deepEqual(p.from, ['kim', 'me']);
  assert.deepEqual(p.in, ['#launch', 'ann lee']);
  assert.deepEqual(p.has, ['file', 'image', 'link']);
  assert.equal(p.thread, true);
  assert.equal(anything(p), true);
  assert.equal(anything(parseChatQuery('  ')), false);
});

test('dates are days where you are', () => {
  const at = Date.UTC(2026, 10, 1);
  assert.equal(parseChatQuery('after:2026-11-01').after, at);
  assert.equal(parseChatQuery('before:2026/11/01', { tzo: -60 }).before, at - 36e5, 'an hour ahead of UTC: midnight there is 23:00 UTC');
  const on = parseChatQuery('on:2026-11-01');
  assert.deepEqual([on.after, on.before], [at, at + 864e5]);
  assert.equal(parseChatQuery('after:2026-11-01 after:2026-11-05').after, Date.UTC(2026, 10, 5), 'the later one');
  assert.equal(parseChatQuery('after:2026-11-01', { tzo: 'x' }).after, at, 'a bad offset is ignored');
});

test('mistakes say what to write', () => {
  assert.match(parseChatQuery('has:spaceship').error, /file, image or link/);
  assert.match(parseChatQuery('after:2026-02-30').error, /2026-11-01/);
  assert.match(parseChatQuery('is:starred').error, /thread/);
  assert.match(parseChatQuery('before:2026-11-01 after:2026-11-02').error, /Nothing can be/);
  assert.equal(parseChatQuery('from:').error, 'Add something after from:');
  assert.deepEqual(parseChatQuery('-from:kim').without, ['from', 'kim'], 'a left-out filter is just words');
  assert.deepEqual(parseChatQuery('see https://x.io').words, ['see', 'https', 'x.io'], 'other colons are words');
});
