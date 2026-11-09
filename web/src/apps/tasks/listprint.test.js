import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listPrintHtml, dueText } from './listprint.js';

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
