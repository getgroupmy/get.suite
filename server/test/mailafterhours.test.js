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
