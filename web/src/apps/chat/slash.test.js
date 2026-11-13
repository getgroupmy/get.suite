import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlash, slashSuggestions } from './slash.js';

test('commands', () => {
  assert.deepEqual(parseSlash('/meet'), { cmd: 'meet' });
  assert.deepEqual(parseSlash(' /MEET  '), { cmd: 'meet' });
  assert.deepEqual(parseSlash('/task Send the invoice'), { cmd: 'task', title: 'Send the invoice' });
  assert.equal(parseSlash('/task').error, 'Write the task after /task');
  assert.deepEqual(parseSlash('/poll Lunch? | Pizza | Sushi |  | Salad'), { cmd: 'poll', question: 'Lunch?', options: ['Pizza', 'Sushi', 'Salad'] });
  assert.match(parseSlash('/poll Lunch? | Pizza').error, /option \| option/);
  assert.match(parseSlash(`/poll Q | ${Array.from({ length: 11 }, (_, i) => i).join(' | ')}`).error, /At most 10/);
});

test('not commands: text, a path, an unknown word', () => {
  assert.equal(parseSlash('hello /meet'), null);
  assert.equal(parseSlash('/shrug'), null, 'unknown: sent as it is');
  assert.equal(parseSlash('/usr/bin is a path'), null);
  assert.equal(parseSlash(''), null);
});

test('suggestions while typing', () => {
  assert.deepEqual(slashSuggestions('/').map((s) => s.cmd), ['meet', 'poll', 'task']);
  assert.deepEqual(slashSuggestions('/p').map((s) => s.cmd), ['poll']);
  assert.deepEqual(slashSuggestions('/poll x'), []);
  assert.deepEqual(slashSuggestions('hi'), []);
});
