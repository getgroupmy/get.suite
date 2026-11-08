import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionItems } from './actionitems.js';

const t = (text) => ({ type: 'text', text });
const m = (id, name) => ({ type: 'mention', attrs: { id, name, email: '' } });
const item = (checked, ...content) => ({ type: 'taskItem', attrs: { checked }, content: [{ type: 'paragraph', content }] });

test('action items: unticked items that mention someone, with dates read', () => {
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [t('Attendees: '), m('k', 'Kim Park')] },
    { type: 'taskList', content: [
      item(false, m('k', 'Kim Park'), t(' send the figures by Friday')),
      item(true, m('k', 'Kim Park'), t(' done already')),
      item(false, t('Nobody in particular')),
      item(false, t('Book room for '), m('k', 'Kim Park'), t(' and '), m('l', 'Lee Fox'), t(' tomorrow 3pm')),
    ] },
  ] };
  const got = actionItems(doc, '2026-11-08');
  assert.deepEqual(got.map((x) => [x.user_id, x.title, x.due, x.due_time]), [
    ['k', 'send the figures', '2026-11-13', null],
    ['k', 'Book room', '2026-11-09', '15:00'],
    ['l', 'Book room', '2026-11-09', '15:00'],
  ]);
  assert.equal(got[0].text, '@Kim Park send the figures by Friday');
  assert.deepEqual(actionItems({ type: 'doc', content: [] }, '2026-11-08'), []);
});
