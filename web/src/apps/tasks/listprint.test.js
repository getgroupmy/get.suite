import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listPrintHtml, dueText, linkIcon } from './listprint.js';

test('a printed list: open tasks with what matters, then done ones, all escaped', () => {
  const html = listPrintHtml('Launch <1>', [
    { title: 'Write <copy>', due: '2026-12-01', due_time: '09:30', assignee_name: 'Kim', tags: ['web'], notes: 'a\nb', steps: [{ title: 'Draft', done: true }], important: true },
  ], [{ title: 'Book room', steps: [] }], { locale: 'en-GB', printedOn: new Date(2026, 10, 9) });
  assert.match(html, /<title>Launch &lt;1&gt;<\/title>/);
  assert.match(html, /★ Write &lt;copy&gt;/);
  assert.match(html, /Due Tue,? 1 Dec 2026, 09:30 · For Kim · #web/);
  assert.match(html, /a<br>b/);
  assert.match(html, /☑ Draft/);
  assert.match(html, /1 to do, 1 done · printed 9 Nov 2026/);
  assert.ok(html.indexOf('Write') < html.indexOf('Completed') && html.indexOf('Completed') < html.indexOf('Book room'));
  assert.ok(!html.includes('<copy>'));
});

test('due dates', () => {
  assert.equal(dueText({}), '');
  assert.match(dueText({ due: '2026-12-01' }, 'en-GB'), /^Tue,? 1 Dec 2026$/);
});

import { listEmail, taskEmail, taskNote } from './listprint.js';
test('a list as an email: open tasks as a checklist with dates and steps, done ones only if asked, a link back', () => {
  const open = [{ title: 'Book <venue>', due: '2026-12-01', assignee_name: 'Kim', steps: [{ title: 'Call', done: true }, { title: 'Pay' }], important: true }];
  const done = [{ title: 'Pick a date' }];
  const m = listEmail('Party', open, done, { locale: 'en-GB', link: 'https://ws.test/tasks/l1' });
  assert.equal(m.subject, 'Party');
  assert.match(m.html, /☐ ★ Book &lt;venue&gt; <span style="color:#5f6368">\(due Tue,? 1 Dec 2026, for Kim\)<\/span>/);
  assert.match(m.html, /☑ Call<\/li><li>☐ Pay/);
  assert.doesNotMatch(m.html, /Pick a date/, 'done ones left out');
  assert.match(m.html, /The list in Tasks: <a href="https:\/\/ws\.test\/tasks\/l1">/);
  assert.match(listEmail('Party', open, done, { withDone: true }).html, /<strong>Done<\/strong>.*☑ <s>Pick a date<\/s>/);
  assert.match(listEmail('Empty', [], []).html, /Nothing left to do/);
});

test('one task as an email: its title as the subject; due, who, notes and steps; a link back; markup escaped', () => {
  const m = taskEmail({ title: 'Book <the> venue', due: '2026-12-01', assignee_name: 'Kim Park', important: true, notes: 'Ask for the big room\nBy phone',
    steps: [{ title: 'Call', done: true }, { title: 'Pay deposit', done: false }] }, { locale: 'en-GB', link: 'https://ws.test/tasks/l1?task=t1', listName: 'Party' });
  assert.equal(m.subject, 'Book <the> venue');
  assert.match(m.html, /<strong>Book &lt;the&gt; venue<\/strong>/);
  assert.match(m.html, /Due Tue, 1 Dec 2026 · For Kim Park · ★ Important · In Party/);
  assert.match(m.html, /Ask for the big room<br>By phone/);
  assert.match(m.html, /☑ Call<\/li><li>☐ Pay deposit/);
  assert.match(m.html, /href="https:\/\/ws\.test\/tasks\/l1\?task=t1"/);
  const done = taskEmail({ title: 'Sent', done: true });
  assert.match(done.html, /<s>Sent<\/s>/);
  assert.match(done.html, />Done</);
  assert.doesNotMatch(done.html, /The task in Tasks/);
});

test('one task as a note: its title; due, who and list; notes; steps as lines; a link back', () => {
  const n = taskNote({ title: 'Book the venue', due: '2026-12-01', assignee_name: 'Kim Park', notes: 'Ask for the big room ',
    steps: [{ title: 'Call', done: true }, { title: 'Pay deposit', done: false }] }, { locale: 'en-GB', link: 'https://ws.test/tasks/l1?task=t1', listName: 'Party' });
  assert.equal(n.title, 'Book the venue');
  assert.equal(n.body, 'Due Tue, 1 Dec 2026 · For Kim Park · In Party\n\nAsk for the big room\n\n✓ Call\n☐ Pay deposit\n\nOpen the task: https://ws.test/tasks/l1?task=t1');
  assert.deepEqual(taskNote({ title: 'Bare' }), { title: 'Bare', body: '' });
  assert.equal(taskNote({ title: 'Sent', done: true }).body, 'Done');
});

test('the picture beside a task’s link says where it goes', () => {
  assert.deepEqual(['/chat/1', '/docs/1', '/sheets/1', '/slides/1', '/drive?preview=1', '/drive/folder/1', '/calendar?event=1', '/contacts?q=Dana', '/forms/1?tab=responses', '/mail?open=1', null].map(linkIcon),
    ['💬', '📄', '📊', '🖼', '📁', '📁', '📅', '👤', '📋', '✉', '✉']);
});
