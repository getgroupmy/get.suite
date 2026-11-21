import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLASH, parseSlash, slashSuggestions, remindWhen } from './slash.js';

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
  assert.deepEqual(slashSuggestions('/').map((s) => s.cmd), ['meet', 'poll', 'task', 'event', 'dnd', 'status', 'thanks', 'invite', 'topic', 'mute', 'leave', 'remind']);
  assert.deepEqual(slashSuggestions('/m').map((s) => s.cmd), ['meet', 'mute']);
  assert.deepEqual(slashSuggestions('/p').map((s) => s.cmd), ['poll']);
  assert.deepEqual(slashSuggestions('/s').map((s) => s.cmd), ['status']);
  assert.deepEqual(slashSuggestions('/poll x'), []);
  assert.deepEqual(slashSuggestions('/th').map((s) => s.cmd), ['thanks']);
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
  assert.deepEqual(SLASH.filter((s) => s.alone).map((s) => s.cmd), ['meet', 'event', 'dnd', 'status', 'topic', 'mute', 'leave']);
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

test('/event: the words after it, read by Calendar quick add', () => {
  assert.deepEqual(parseSlash('/event'), { cmd: 'event', text: '' });
  assert.deepEqual(parseSlash('/event Planning friday 3pm'), { cmd: 'event', text: 'Planning friday 3pm' });
});

test('/thanks: a colleague (as the @ list writes them), an optional emoji, what for', () => {
  assert.deepEqual(parseSlash('/thanks @Kim@Acme.com for the demo'), { cmd: 'thanks', to: 'kim@acme.com', message: 'for the demo' });
  assert.deepEqual(parseSlash('/thanks @kim@acme.com 🎉 great launch'), { cmd: 'thanks', to: 'kim@acme.com', message: 'great launch', emoji: '🎉' });
  assert.deepEqual(parseSlash('/thanks @kim@acme.com ❤️ you’re the best'), { cmd: 'thanks', to: 'kim@acme.com', message: 'you’re the best', emoji: '❤️' });
  assert.equal(parseSlash('/thanks @kim@acme.com 🍕 lunch').emoji, undefined, 'only the thank-you emoji');
  assert.match(parseSlash('/thanks kim for it').error, /\/thanks @someone/);
  assert.match(parseSlash('/thanks @kim@acme.com').error, /what you’re thanking/);
  assert.match(parseSlash(`/thanks @kim@acme.com ${'x'.repeat(281)}`).error, /280/);
});

test('/invite: colleagues as the @ list writes them', () => {
  assert.deepEqual(parseSlash('/invite @Kim@Acme.com @ben@acme.com, @kim@acme.com'), { cmd: 'invite', usernames: ['kim@acme.com', 'ben@acme.com'] });
  assert.match(parseSlash('/invite').error, /\/invite @someone/);
  assert.match(parseSlash('/invite @kim').error, /@ list/);
});

test('/topic, /mute, /leave', () => {
  assert.deepEqual(parseSlash('/topic Launch on the 3rd'), { cmd: 'topic', topic: 'Launch on the 3rd' });
  assert.deepEqual(parseSlash('/topic'), { cmd: 'topic', topic: '' });
  assert.match(parseSlash(`/topic ${'x'.repeat(251)}`).error, /250/);
  assert.deepEqual(parseSlash('/mute'), { cmd: 'mute' });
  assert.deepEqual(parseSlash('/mute 2h'), { cmd: 'mute', minutes: 120 });
  assert.deepEqual(parseSlash('/mute for 3 days'), { cmd: 'mute', minutes: 4320 });
  assert.deepEqual(parseSlash('/mute off'), { cmd: 'mute', off: true });
  assert.match(parseSlash('/mute forever').error, /\/mute 2h/);
  assert.match(parseSlash('/mute 400d').error, /a year/);
  assert.deepEqual(parseSlash('/leave'), { cmd: 'leave' });
  assert.equal(parseSlash('/leave early today'), null, 'just a message');
});

test('/remind: what and when (in 2h, tomorrow 9am, fri 3pm, a day alone at 9:00)', () => {
  assert.deepEqual(parseSlash('/remind me to call Kim in 2h'), { cmd: 'remind', text: 'me to call Kim in 2h' });
  assert.match(parseSlash('/remind').error, /\/remind me to/);
  const now = new Date(2026, 10, 21, 15, 0); // Saturday 21 November 2026, 15:00
  assert.deepEqual(remindWhen('me to call Kim in 2h', now), { text: 'call Kim', at: now.getTime() + 2 * 36e5 });
  assert.deepEqual(remindWhen('stretch in 45 minutes', now), { text: 'stretch', at: now.getTime() + 45 * 60e3 });
  assert.deepEqual(remindWhen('me about the invoice in a day', now), { text: 'the invoice', at: now.getTime() + 864e5 });
  assert.deepEqual(remindWhen('me to send the slides tomorrow 9am', now), { text: 'send the slides', at: new Date(2026, 10, 22, 9, 0).getTime() });
  assert.deepEqual(remindWhen('book the room fri 3pm', now), { text: 'book the room', at: new Date(2026, 10, 27, 15, 0).getTime() });
  assert.deepEqual(remindWhen('pay rent monday', now), { text: 'pay rent', at: new Date(2026, 10, 23, 9, 0).getTime() });
  assert.match(remindWhen('call Kim', now).error, /Say when/);
  assert.match(remindWhen('in 2h', now).error, /Say what/);
  assert.match(remindWhen('call Kim at 9am', now).error, /passed/);
  assert.match(remindWhen('call Kim in 400 days', now).error, /a year/);
});
