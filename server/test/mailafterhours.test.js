import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-afterhours-db-')); // a database of its own
const { afterHours } = await import('../src/mail/afterhours.js');
const { setHours } = await import('../src/workhours.js');
const { q } = await import('../src/db.js');

q("INSERT INTO orgs (id, name, created_at) VALUES ('ao', 'A', 0), ('bo', 'B', 0)").run();
const add = (id, org, name) => q("INSERT INTO users (id, org_id, username, name, password_hash, created_at) VALUES (?, ?, ?, ?, 'x', 0)").run(id, org, `${id}@a.example`, name);
add('me', 'ao', 'Me'); add('tok', 'ao', 'Kim Tokyo'); add('lon', 'ao', 'Lee London'); add('nohours', 'ao', 'No Hours'); add('other', 'bo', 'Other Co');
setHours('tok', { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60, tz: 'Asia/Tokyo' });
setHours('lon', { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60, tz: 'Europe/London' });
setHours('other', { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60, tz: 'Asia/Tokyo' });
const me = { id: 'me', org_id: 'ao', username: 'me@a.example' };

test('after hours: colleagues outside the hours they set, with their local time and when they start', () => {
  const now = Date.parse('2026-11-12T14:10:00Z'); // Thursday: 23:10 in Tokyo, 14:10 in London
  const r = afterHours(me, ['TOK@a.example', 'lon@a.example', 'nohours@a.example', 'other@a.example', 'me@a.example', 'pat@x.example'], now);
  assert.deepEqual(r.map((x) => [x.email, x.local]), [['tok@a.example', '23:10']], 'London is working; no own hours; another company; yourself; outsiders');
  assert.equal(new Date(r[0].next).toISOString(), '2026-11-13T00:00:00.000Z', '9:00 Friday in Tokyo');
  assert.equal(r[0].name, 'Kim Tokyo');
  assert.equal(r[0].tz, 'Asia/Tokyo');
});

test('after hours: over the weekend their next start is Monday; a quarter hour before starting counts as working', () => {
  const sat = Date.parse('2026-11-14T12:00:00Z'); // Saturday
  const r = afterHours(me, ['lon@a.example'], sat);
  assert.equal(new Date(r[0].next).toISOString(), '2026-11-16T09:00:00.000Z');
  assert.deepEqual(afterHours(me, ['lon@a.example'], Date.parse('2026-11-16T08:50:00Z')), [], 'starting in 10 minutes');
});

test('away: colleagues whose vacation reply is on today, until when; not before it starts or after it ends', async () => {
  const { awayRecipients } = await import('../src/mail/afterhours.js');
  const set = (id, enabled, start, end, subject = 'Out of office') => q(`INSERT INTO vacations (user_id, enabled, subject, body, start_date, end_date, updated_at) VALUES (?, ?, ?, '', ?, ?, 0)
    ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, start_date = excluded.start_date, end_date = excluded.end_date, subject = excluded.subject`).run(id, enabled, subject, start, end);
  const now = Date.parse('2026-11-12T10:00:00Z');
  set('tok', 1, '2026-11-10', '2026-11-20', 'On holiday');
  set('lon', 1, null, null);
  set('nohours', 0, null, null);
  set('other', 1, null, null);
  const r = awayRecipients(me, ['tok@a.example', 'LON@a.example', 'nohours@a.example', 'other@a.example', 'me@a.example'], now);
  assert.deepEqual(r, [
    { email: 'tok@a.example', name: 'Kim Tokyo', until: '2026-11-20', subject: 'On holiday' },
    { email: 'lon@a.example', name: 'Lee London', until: null, subject: 'Out of office' },
  ], 'switched off and other companies left out');
  set('tok', 1, '2026-11-13', '2026-11-20');
  assert.deepEqual(awayRecipients(me, ['tok@a.example'], now), [], 'not started yet');
  set('tok', 1, '2026-11-01', '2026-11-11');
  assert.deepEqual(awayRecipients(me, ['tok@a.example'], now), [], 'over');
});

test('full: colleagues whose mailbox the hourly check found full; not nearly full, not without a limit', async () => {
  const { fullRecipients } = await import('../src/mail/afterhours.js');
  q("UPDATE users SET mail_quota_mb = 100, mail_full_told = 100 WHERE id IN ('tok', 'other')").run();
  q("UPDATE users SET mail_quota_mb = 100, mail_full_told = 90 WHERE id = 'lon'").run();
  q("UPDATE users SET mail_quota_mb = 0, mail_full_told = 100 WHERE id = 'nohours'").run();
  assert.deepEqual(fullRecipients(me, ['TOK@a.example', 'lon@a.example', 'nohours@a.example', 'other@a.example']), [{ email: 'tok@a.example', name: 'Kim Tokyo' }]);
});
