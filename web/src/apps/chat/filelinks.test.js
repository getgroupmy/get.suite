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

test('task links: relative or on this server, each once, at most three', async () => {
  const { taskLinksIn, taskLink } = await import('./filelinks.js');
  assert.deepEqual(taskLinksIn('do https://ws.example/tasks/list123?task=task456 now', 'ws.example'), [{ list: 'list123', id: 'task456' }]);
  assert.deepEqual(taskLinksIn('/tasks/list123?task=task456 /tasks/list123?task=task456', 'h'), [{ list: 'list123', id: 'task456' }]);
  assert.deepEqual(taskLinksIn('https://other.example/tasks/list123?task=task456', 'ws.example'), [], 'another server');
  assert.deepEqual(taskLinksIn('/tasks/planned /tasks/list123', 'h'), [], 'not a task');
  assert.equal(taskLink({ list_id: 'list123', id: 'task456' }, 'https://ws'), 'https://ws/tasks/list123?task=task456');
  assert.equal(taskLinksIn('/tasks/assigned?task=task456', 'h').length, 1, 'any list in the address; the task decides');
});

test('event links: with the time of a repeating one, on this server only', async () => {
  const { eventLinksIn, eventLink } = await import('./filelinks.js');
  assert.deepEqual(eventLinksIn('see https://ws.example/calendar?event=evt123456 ok', 'ws.example'), [{ id: 'evt123456', at: null }]);
  assert.deepEqual(eventLinksIn('/calendar?event=evt123456&at=1764752400000 and /calendar?event=evt123456&at=1765357200000', 'h'),
    [{ id: 'evt123456', at: 1764752400000 }, { id: 'evt123456', at: 1765357200000 }], 'two times of one event');
  assert.deepEqual(eventLinksIn('https://other.example/calendar?event=evt123456', 'ws.example'), []);
  assert.deepEqual(eventLinksIn('/calendar?timeoff=1 /calendar', 'h'), []);
  assert.equal(eventLink({ id: 'e1', start: 5, rrule: null }, 'https://ws'), 'https://ws/calendar?event=e1');
  assert.equal(eventLink({ id: 'e1', start: 1764752400000, rrule: { freq: 'weekly' } }, 'https://ws'), 'https://ws/calendar?event=e1&at=1764752400000');
});

test('note links: on this server, each once', async () => {
  const { noteLinksIn, noteLink } = await import('./filelinks.js');
  assert.deepEqual(noteLinksIn('list: https://ws.example/notes?note=note123 and /notes?note=note123', 'ws.example'), [{ id: 'note123' }]);
  assert.deepEqual(noteLinksIn('https://other.example/notes?note=note123', 'ws.example'), []);
  assert.deepEqual(noteLinksIn('/notes /notes?note=ab', 'h'), []);
  assert.deepEqual(noteLinksIn(noteLink({ id: 'note123' }, 'https://ws.example'), 'ws.example'), [{ id: 'note123' }]);
});

test('form links: /f/<token> on this server, each once', async () => {
  const { formLinksIn } = await import('./filelinks.js');
  assert.deepEqual(formLinksIn('fill in https://ws.example/f/AbC_dEf-123456 please, and /f/AbC_dEf-123456', 'ws.example'), [{ token: 'AbC_dEf-123456' }]);
  assert.deepEqual(formLinksIn('https://other.example/f/AbC_dEf-123456', 'ws.example'), []);
  assert.deepEqual(formLinksIn('/f/short /f/AbC_dEf-123456/pictures/x', 'h'), [], 'too short, or a picture in it');
});
