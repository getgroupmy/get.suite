import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEXT_LINK_RE } from './textlinks.js';

const links = (t) => t.split(TEXT_LINK_RE).filter((_, i) => i % 2);
test('web addresses and Workspace paths in a comment are links; the full stop after one is not part of it', () => {
  assert.deepEqual(links('See https://acme.com/price-list. Thanks'), ['https://acme.com/price-list']);
  assert.deepEqual(links('(https://example.org/a?b=1)'), ['https://example.org/a?b=1']);
  assert.deepEqual(links('In /docs/abc123 and /notes?note=x9, also /tasks/l1?task=t2'), ['/docs/abc123', '/notes?note=x9', '/tasks/l1?task=t2']);
  assert.deepEqual(links('a/b and 1/2 and kim@acme.com/notes and /etc/passwd'), [], 'not a slash in other words, or other paths');
});
