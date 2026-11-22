import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agendaDoc } from './agendadoc.js';

const text = (n) => (n.text || '') + (n.content || []).map(text).join(n.type === 'tableRow' ? '|' : n.type === 'table' ? '/' : '');

test('an agenda as a document: a heading a day, a table of times and what’s on (where, out of office), all-day first as given', () => {
  const day = new Date(Date.UTC(2026, 11, 3));
  const at = (h, m = 0) => Date.UTC(2026, 11, 3, h, m);
  const doc = agendaDoc('This week', [{ day, items: [
    { title: 'Conference', all_day: true },
    { title: 'Design review', start: at(9, 30), end: at(10, 30), location: 'Room 4' },
    { title: '', start: at(14), end: at(15), kind: 'ooo' },
  ] }], { dayName: () => 'Thursday, 3 December' });
  assert.deepEqual(doc.content.map((n) => `${n.type}:${text(n)}`), [
    'heading:This week', 'heading:Thursday, 3 December',
    'table:When|What/All day|Conference/09:30 – 10:30|Design review · Room 4/14:00 – 15:00|(No title) (out of office)',
  ]);
  assert.equal(doc.content[2].content[0].content[0].type, 'tableHeader');
  assert.deepEqual(doc.content[2].content[2].content[1].content[0].content[0].marks, [{ type: 'bold' }]);
  assert.deepEqual(agendaDoc('Empty', []).content.map((n) => text(n)), ['Empty', 'Nothing scheduled.']);
});
