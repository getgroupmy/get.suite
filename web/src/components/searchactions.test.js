import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchActions, detailedActions, wantsEvent, wantsPeople, wantsChannels, noteFrom, mailFrom, chatFrom } from './searchactions.js';

const keys = (l) => l.map((a) => a.key);

test('quick actions: every word typed starts one of theirs; mail and admin only when they apply', () => {
  assert.deepEqual(keys(matchActions('new doc')), ['doc']);
  assert.deepEqual(keys(matchActions('compose')), ['mail']);
  assert.deepEqual(keys(matchActions('compose', { mail: false })), []);
  assert.deepEqual(keys(matchActions('meeting')), ['event', 'meet']);
  assert.deepEqual(keys(matchActions('sheet')), ['sheet']);
  assert.deepEqual(keys(matchActions('admin')), []);
  assert.deepEqual(keys(matchActions('admin', { admin: true })), ['admin']);
  assert.deepEqual(keys(matchActions('n')), [], 'too short');
  assert.deepEqual(keys(matchActions('budget review')), [], 'a plain search finds no action');
  assert.equal(matchActions('new').length, 3, 'at most three');
});

const today = '2026-11-13'; // a Friday
test('"event …" with a day or time: that very event, read by Calendar quick add', () => {
  const [a] = detailedActions('event Lunch with @kim tomorrow 1pm in Lisbon', { today, people: [{ name: 'Kim Park', username: 'kim@acme.com' }], rooms: [{ id: 'l', name: 'Lisbon' }] });
  assert.equal(a.title, 'New event: Lunch with Kim');
  assert.equal(a.quickEvent.start, new Date(2026, 10, 14, 13).getTime());
  assert.deepEqual([a.quickEvent.guests, a.quickEvent.rooms], [['kim@acme.com'], ['l']]);
  assert.equal(detailedActions('Meeting tomorrow 3pm', { today })[0].title, 'New event: (no title)');
  assert.deepEqual(detailedActions('event planning', { today }), [], 'no day or time: the plain "New event" does');
  assert.deepEqual(detailedActions('events in november', { today }), [], '"events" is a search');
  assert.equal(wantsEvent('new event Retro friday 4pm'), true);
  assert.equal(wantsEvent('eventual'), false);
});

test('"task …": that task, read by Tasks quick add', () => {
  const [a] = detailedActions('task Send invoice friday 3pm every month !high #billing', { today });
  assert.equal(a.title, 'Add task: Send invoice');
  assert.deepEqual(a.quickTask, { title: 'Send invoice', due: '2026-11-20', due_time: '15:00', repeat: 'monthly', important: false, priority: 'high', tags: ['billing'] });
  assert.deepEqual(detailedActions('remind me to call Bo tomorrow', { today })[0].quickTask.due, '2026-11-14');
  assert.deepEqual(detailedActions('todo Buy milk', { today })[0].quickTask.due, null);
  assert.deepEqual(detailedActions('tasks', { today }), []);
  assert.deepEqual(detailedActions('budget review', { today }), []);
});

test('"note …" and "list …": a note or a checklist, #labels taken out', () => {
  const [a] = detailedActions('note Call the bank about the card #home', { today });
  assert.deepEqual([a.title, a.quickNote], ['Add note: Call the bank about the card', { body: 'Call the bank about the card', labels: ['home'] }]);
  const [l] = detailedActions('list milk, eggs ,  bread, #Shopping', { today });
  assert.deepEqual(l.quickNote, { items: [{ text: 'milk', done: false }, { text: 'eggs', done: false }, { text: 'bread', done: false }], labels: ['shopping'] });
  assert.equal(l.title, 'Add checklist: milk, eggs, bread');
  assert.equal(noteFrom('note', '#only'), null);
  assert.deepEqual(detailedActions('notes', { today }), []);
  assert.deepEqual(detailedActions('note', { today }), []);
});

test('"email @kim …": a message to them with the rest as its subject; nobody named: nothing', () => {
  const people = [{ name: 'Kim Park', username: 'kim@acme.com' }, { name: 'Ana Silva', username: 'ana@acme.com' }];
  const [a] = detailedActions('email @kim Budget figures', { today, people });
  assert.deepEqual([a.title, a.quickMail], ['Email Kim Park', { to: ['kim@acme.com'], subject: 'Budget figures' }]);
  assert.deepEqual(mailFrom('@Ana Silva and jo@client.com about the Q3 plan', people), { to: ['ana@acme.com', 'jo@client.com'], subject: 'the Q3 plan' });
  assert.deepEqual(mailFrom('kim@acme.com', people), { to: ['kim@acme.com'], subject: '' });
  assert.deepEqual(mailFrom('@kim, @ana: lunch?', people), { to: ['kim@acme.com', 'ana@acme.com'], subject: 'lunch?' });
  assert.deepEqual(detailedActions('email the team', { today, people }), [], 'nobody: the plain "Write an email" does');
  assert.deepEqual(detailedActions('email @kim hi', { today, people, mail: false }), [], 'no email on this server');
  assert.equal(wantsPeople('write to @kim'), true);
  assert.equal(wantsPeople('task x'), false);
});

test('"chat @kim …" and "chat #launch …": that conversation, the rest to start the message', () => {
  const people = [{ id: 'k', name: 'Kim Park', username: 'kim@acme.com' }, { id: 's1', name: 'Sam Lee', username: 'sam@acme.com' }, { id: 's2', name: 'Sam Ortiz', username: 'sortiz@acme.com' }];
  const channels = [{ id: 'c1', name: 'launch' }, { id: 'c2', name: 'Old', archived_at: 1 }, { id: 'd', dm_key: 'x', name: 'kim' }];
  const [a] = detailedActions('chat @kim Are we still on for 3?', { today, people, channels });
  assert.deepEqual([a.title, a.quickChat.person.id, a.quickChat.text], ['Message Kim Park: Are we still on for 3?', 'k', 'Are we still on for 3?']);
  assert.deepEqual(chatFrom('@Sam Ortiz: running late', { people }), { person: people[2], text: 'running late' });
  assert.equal(chatFrom('@sam hi', { people }), null, 'two Sams');
  assert.deepEqual(chatFrom('@sortiz hi', { people }), { person: people[2], text: 'hi' });
  assert.equal(detailedActions('dm @kim', { today, people })[0].title, 'Open chat with Kim Park');
  const [b] = detailedActions('chat #Launch Shipped it!', { today, people, channels });
  assert.deepEqual([b.title, b.quickChat.channel.id, b.quickChat.text], ['Message #launch: Shipped it!', 'c1', 'Shipped it!']);
  assert.equal(detailedActions('message in #launch hello', { today, people, channels })[0].quickChat.channel.id, 'c1', 'not an email');
  assert.deepEqual(detailedActions('chat #old hi', { today, channels }), [], 'archived');
  assert.deepEqual(detailedActions('chat about the launch', { today, people, channels }), []);
  assert.equal(wantsChannels('chat #x'), true);
  assert.equal(wantsPeople('dm @kim'), true);
});
