import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchBlocks, bodyHtml, draftMessage, eventFromDraft, guestList, whenText } from './blocks.js';

test('building blocks: email drafts for @email, event drafts for @event or @meeting, both for @draft (two letters on)', () => {
  assert.deepEqual(matchBlocks('em'), [{ kind: 'block', id: 'block:email', label: 'Email draft' }]);
  assert.equal(matchBlocks('draft').length, 2, 'both drafts');
  assert.equal(matchBlocks('e').length, 0);
  assert.equal(matchBlocks('kim').length, 0);
  assert.deepEqual(matchBlocks('mee'), [{ kind: 'block', id: 'block:event', label: 'Event draft' }]);
  assert.deepEqual(matchBlocks('ev').map((b) => b.label), ['Event draft']);
});

test('event drafts: the event for Calendar from the fields, notes and the document', () => {
  const doc = { id: 'd1', name: 'Kickoff plan' };
  const ev = eventFromDraft({ title: ' Kickoff ', date: '2026-11-12', start: '10:00', end: '11:30', guests: 'Kim@acme.com; bo@acme.com, kim@acme.com', location: 'Room 4' }, 'Agenda: scope, dates', doc, 'https://w.acme.com');
  assert.equal(ev.title, 'Kickoff');
  assert.equal(ev.start, new Date(2026, 10, 12, 10, 0).getTime());
  assert.equal(ev.end, new Date(2026, 10, 12, 11, 30).getTime());
  assert.equal(ev.all_day, 0);
  assert.deepEqual(ev.guests, [{ email: 'kim@acme.com' }, { email: 'bo@acme.com' }]);
  assert.equal(ev.location, 'Room 4');
  assert.equal(ev.description, 'Agenda: scope, dates\n\nFrom “Kickoff plan”: https://w.acme.com/docs/d1');
  assert.deepEqual(ev.attachments, [{ id: 'd1', name: 'Kickoff plan', kind: 'doc', mime: null }]);
  // No end: an hour; no start: all day.
  assert.equal(eventFromDraft({ title: 'x', date: '2026-11-12', start: '09:00' }, '', doc, '').end, new Date(2026, 10, 12, 10, 0).getTime());
  const day = eventFromDraft({ title: 'Offsite', date: '2026-11-12' }, '', null, '');
  assert.equal(day.all_day, 1);
  assert.equal(day.end - day.start > 0, true);
  assert.deepEqual(day.attachments, []);
  assert.equal(day.description, '');
  // What's missing or wrong is said.
  assert.match(eventFromDraft({ date: '2026-11-12' }, '', doc, '').error, /title/);
  assert.match(eventFromDraft({ title: 'x', date: '' }, '', doc, '').error, /day/);
  assert.match(eventFromDraft({ title: 'x', date: '2026-11-12', start: '11:00', end: '10:00' }, '', doc, '').error, /end/);
  assert.deepEqual(guestList('not-an-address, a@b.co'), ['a@b.co']);
  assert.equal(whenText({ date: '2026-11-12', start: '10:00', end: '11:00' }), '2026-11-12 · 10:00–11:00');
  assert.equal(whenText({ date: '2026-11-12' }), '2026-11-12');
});

test('email drafts: the message for Mail, with full links and fields on one line', () => {
  const html = '<p>See <a data-filechip="f1" class="doc-filechip" href="/sheets/f1">📊 Budget</a> and <a href="https://x.example/a">this</a>.</p>';
  assert.equal(bodyHtml(html, 'https://work.acme.com'), '<p>See <a data-filechip="f1" href="https://work.acme.com/sheets/f1">📊 Budget</a> and <a href="https://x.example/a">this</a>.</p>');
  assert.deepEqual(draftMessage({ to: ' kim@acme.com,\nbo@acme.com ', cc: '', subject: 'Q3\r\nfigures' }, '', 'https://w'), { to: 'kim@acme.com, bo@acme.com', cc: '', subject: 'Q3 figures', html: '<p></p>' });
});
