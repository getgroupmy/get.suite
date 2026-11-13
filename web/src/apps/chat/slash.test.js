import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLASH, parseSlash, slashSuggestions } from './slash.js';

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
  assert.deepEqual(slashSuggestions('/').map((s) => s.cmd), ['meet', 'poll', 'task', 'dnd', 'status']);
  assert.deepEqual(slashSuggestions('/p').map((s) => s.cmd), ['poll']);
  assert.deepEqual(slashSuggestions('/s').map((s) => s.cmd), ['status']);
  assert.deepEqual(slashSuggestions('/poll x'), []);
  assert.deepEqual(slashSuggestions('hi'), []);
});

test('/status: emoji, words and how long; alone it clears', () => {
  assert.deepEqual(parseSlash('/status 🍔 Lunch 1h'), { cmd: 'status', emoji: '🍔', text: 'Lunch', after: 60 });
  assert.deepEqual(parseSlash('/status 🍔Lunch for 45 minutes'), { cmd: 'status', emoji: '🍔', text: 'Lunch', after: 45 });
  assert.deepEqual(parseSlash('/status 👩🏽‍💻 Heads down 2 hours'), { cmd: 'status', emoji: '👩🏽‍💻', text: 'Heads down', after: 120 });
  assert.deepEqual(parseSlash('/status ✈️ Flying this week'), { cmd: 'status', emoji: '✈️', text: 'Flying', after: 'week' });
  assert.deepEqual(parseSlash('/status Working from the Leeds office'), { cmd: 'status', emoji: '💬', text: 'Working from the Leeds office', after: 'today' });
  assert.deepEqual(parseSlash('/status 🤒'), { cmd: 'status', emoji: '🤒', text: '', after: 'today' });
  assert.deepEqual(parseSlash('/status Back at 3pm today'), { cmd: 'status', emoji: '💬', text: 'Back at 3pm', after: 'today' });
  assert.deepEqual(parseSlash('/status Room 101'), { cmd: 'status', emoji: '💬', text: 'Room 101', after: 'today' }, 'a number alone is words');
  assert.deepEqual(parseSlash('/status'), { cmd: 'status', clear: true });
  assert.deepEqual(parseSlash('/status clear'), { cmd: 'status', clear: true });
  assert.match(parseSlash('/status 1h').error, /\/status 🍔 Lunch 1h/);
  assert.match(parseSlash('/status Lunch 0m').error, /a minute to a year/);
  assert.match(parseSlash(`/status ${'x'.repeat(101)}`).error, /100 characters/);
});

test('which commands are complete on their own', () => {
  assert.deepEqual(SLASH.filter((s) => s.alone).map((s) => s.cmd), ['meet', 'dnd', 'status']);
});

test('/dnd: an hour, how long, tomorrow, or off', () => {
  assert.deepEqual(parseSlash('/dnd'), { cmd: 'dnd', minutes: 60 });
  assert.deepEqual(parseSlash('/dnd 30m'), { cmd: 'dnd', minutes: 30 });
  assert.deepEqual(parseSlash('/DND for 2 hours'), { cmd: 'dnd', minutes: 120 });
  assert.deepEqual(parseSlash('/dnd until tomorrow'), { cmd: 'dnd', tomorrow: true });
  assert.deepEqual(parseSlash('/dnd off'), { cmd: 'dnd', off: true });
  assert.match(parseSlash('/dnd forever').error, /\/dnd 30m/);
  assert.match(parseSlash('/dnd 0m').error, /up to a month/);
  assert.match(parseSlash('/dnd 800h').error, /up to a month/);
});
