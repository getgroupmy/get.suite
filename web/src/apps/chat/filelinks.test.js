import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileLinksIn } from './filelinks.js';

test('file links: relative or on this server, each once, at most three', () => {
  assert.deepEqual(fileLinksIn('See /docs/abc123 and https://ws.example/sheets/def456?x=1 please', 'ws.example'), [{ id: 'abc123', kind: 'doc' }, { id: 'def456', kind: 'sheet' }]);
  assert.deepEqual(fileLinksIn('https://other.example/docs/abc123', 'ws.example'), [], 'another server');
  assert.deepEqual(fileLinksIn('/drive/folder/fold3r1 /docs/abc123 /docs/abc123', 'h'), [{ id: 'fold3r1', kind: 'folder' }, { id: 'abc123', kind: 'doc' }]);
  assert.deepEqual(fileLinksIn('/slides/aaaaaa1 /slides/aaaaaa2 /slides/aaaaaa3 /slides/aaaaaa4', 'h').length, 3);
  assert.deepEqual(fileLinksIn('x/docs/abc123 and /docs/ab', 'h'), [], 'not inside a word; ids are long');
  assert.deepEqual(fileLinksIn(''), []);
});
