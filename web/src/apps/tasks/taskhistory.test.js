import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyText, dayText } from './taskhistory.js';

const now = new Date('2026-11-14T10:00:00');
const ana = { id: 'a', name: 'Ana Silva' }, ben = { id: 'b', name: 'Ben Ode' };
const t = (field, before, after, user = ana, me) => historyText({ field, before, after, user }, { now, locale: 'en-GB', me });

test('days: short, with the year only when it is another year, and the time', () => {
  assert.equal(dayText('2026-12-03', now, 'en-GB'), '3 Dec');
  assert.equal(dayText('2027-01-05', now, 'en-GB'), '5 Jan 2027');
  assert.equal(dayText('2026-12-03 15:00', now, 'en-GB'), '3 Dec, 15:00');
});

test('each kind of change as a sentence', () => {
  assert.equal(t('due', null, '2026-12-03'), 'set the due date to 3 Dec');
  assert.equal(t('due', '2026-12-01', '2026-12-03 15:00'), 'changed the due date from 1 Dec to 3 Dec, 15:00');
  assert.equal(t('due', '2026-12-01', null), 'took the due date off (was 1 Dec)');
  assert.equal(t('title', 'Book venue', 'Book the big venue'), 'renamed it from “Book venue” to “Book the big venue”');
  assert.match(t('title', 'x'.repeat(100), 'y'), /^renamed it from “x{59}…” to “y”$/);
  assert.equal(t('notes', null, '1'), 'changed the notes');
  assert.equal(t('notes', null, null), 'cleared the notes');
  assert.equal(t('assignee', null, ben), 'gave it to Ben Ode');
  assert.equal(t('assignee', null, ben, ben), 'took it on');
  assert.equal(t('assignee', ana, ben, ben), 'took it on (it was for Ana Silva)');
  assert.equal(t('assignee', ana, ben, ana, 'b'), 'gave it to you (it was for Ana Silva)');
  assert.equal(t('assignee', ben, null), 'took it off Ben Ode');
  assert.equal(t('status', 'todo', 'done'), 'ticked it off');
  assert.equal(t('status', 'done', 'todo'), 'brought it back to do');
  assert.equal(t('status', 'todo', 'progress'), 'moved it from To do to In progress');
  assert.equal(t('priority', null, 'high'), 'set the priority to High');
  assert.equal(t('priority', 'high', 'low'), 'changed the priority from High to Low');
  assert.equal(t('important', false, true), 'marked it important');
  assert.equal(t('list', 'Launch', 'Later'), 'moved it from Launch to Later');
  assert.equal(t('section', null, 'This week'), 'moved it to the section “This week”');
  assert.equal(t('section', 'This week', null), 'took it out of the section “This week”');
  assert.equal(t('repeat', null, 'weekly'), 'made it repeat: weekly');
  assert.equal(t('repeat', 'weekly', null), 'stopped it repeating');
  assert.equal(t('estimate', 30, 90), 'changed the estimate from 30 min to 1 h 30 min');
  assert.equal(t('tags', [], ['q4', 'venue']), 'added #q4, #venue');
  assert.equal(t('tags', ['q4', 'venue'], ['venue', 'client']), 'added #client and removed #q4');
});

test('steps, files and what it waits on', () => {
  const st = (id, title, done = false) => ({ id, title, done });
  assert.equal(t('steps', [], [st('1', 'Call them')]), 'added the step “Call them”');
  assert.equal(t('steps', [], [st('1', 'Call'), st('2', 'Pay')]), 'added the steps “Call”, “Pay”');
  assert.equal(t('steps', [st('1', 'Call'), st('2', 'Pay')], [st('1', 'Call', true), st('2', 'Pay deposit')]), 'ticked off the step “Call”; renamed the step “Pay” to “Pay deposit”');
  assert.equal(t('steps', [st('1', 'Call', true), st('2', 'Pay')], [st('1', 'Call')]), 'unticked the step “Call”; removed the step “Pay”');
  assert.equal(t('files', [], [{ id: 'f', name: 'Plan.pdf' }]), 'attached “Plan.pdf”');
  assert.equal(t('files', [{ id: 'g', name: 'Old.pdf' }], [{ id: 'f', name: 'A' }, { id: 'h', name: 'B' }]), 'attached 2 files: “A”, “B” and took off “Old.pdf”');
  assert.equal(t('waiting', [], [{ id: 'x', title: 'Design' }]), 'made it wait on “Design”');
  assert.equal(t('waiting', [{ id: 'x', title: 'Design' }], []), 'stopped it waiting on “Design”');
});
