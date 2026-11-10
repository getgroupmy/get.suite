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

test('message links: relative or on this server, with the thread, each once', async () => {
  const { messageLinksIn, messageLink } = await import('./filelinks.js');
  assert.deepEqual(messageLinksIn('look https://ws.example/chat/chan123?msg=msg456&thread=par789 ok', 'ws.example'), [{ channel: 'chan123', id: 'msg456', thread: 'par789' }]);
  assert.deepEqual(messageLinksIn('/chat/chan123?msg=msg456 and /chat/chan123?msg=msg456', 'h'), [{ channel: 'chan123', id: 'msg456', thread: null }]);
  assert.deepEqual(messageLinksIn('https://other.example/chat/chan123?msg=msg456', 'ws.example'), [], 'another server');
  assert.deepEqual(messageLinksIn('/chat/chan123?thread=x /chat/chan123', 'h'), [], 'no message in it');
  assert.equal(messageLink({ channel_id: 'c1', id: 'm1', parent_id: null }, 'https://ws'), 'https://ws/chat/c1?msg=m1');
  assert.equal(messageLink({ channel_id: 'c1', id: 'm2', parent_id: 'm1' }, 'https://ws'), 'https://ws/chat/c1?msg=m2&thread=m1');
  const back = messageLinksIn(messageLink({ channel_id: 'chan123', id: 'msg456', parent_id: 'par789' }, 'https://ws.example'), 'ws.example');
  assert.deepEqual(back, [{ channel: 'chan123', id: 'msg456', thread: 'par789' }], 'what is copied is understood');
});
