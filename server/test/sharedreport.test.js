// The shared mailbox report: per person, open and finished and the median time to finish; finished without being given
// to anyone; the oldest still waiting.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-sharedreport-'));
let q, sharedReport;
before(async () => {
  ({ q } = await import('../src/db.js'));
  ({ sharedReport } = await import('../src/mail/shared.js'));
});

test('per person, overall, and the oldest waiting', () => {
  const now = Date.UTC(2026, 10, 16, 12), h = 36e5, d = 24 * h;
  q("INSERT INTO orgs (id, name, created_at) VALUES ('o', 'Acme', 0)").run();
  for (const [id, name] of [['kim', 'Kim Park'], ['lee', 'Lee Fox'], ['max', 'Max Moss']]) q("INSERT INTO users (id, org_id, username, name, password_hash, created_at) VALUES (?, 'o', ?, ?, 'x', 0)").run(id, `${id}@acme.com`, name);
  q("INSERT INTO shared_mailboxes (id, org_id, address, name, created_at) VALUES ('mb', 'o', 'support@acme.com', 'Support', 0)").run();
  for (const u of ['kim', 'lee', 'max']) q("INSERT INTO shared_mailbox_members (mailbox_id, user_id) VALUES ('mb', ?)").run(u);
  const add = (id, { who = null, done = false, created, assigned = null, finished = null, subject = id }) => q(`INSERT INTO shared_assignments (mailbox_id, message_id, assignee_id, done, subject, updated_by, updated_at, created_at, assigned_at, done_at)
    VALUES ('mb', ?, ?, ?, ?, NULL, ?, ?, ?, ?)`).run(`<${id}@x>`, who, done ? 1 : 0, subject, finished || assigned || created, created, assigned, finished);
  // Kim finished two (2 h and 4 h after being given them) and has one open; one finished long ago isn't counted.
  add('k1', { who: 'kim', done: true, created: now - 3 * d, assigned: now - 3 * d, finished: now - 3 * d + 2 * h });
  add('k2', { who: 'kim', done: true, created: now - 2 * d, assigned: now - 2 * d, finished: now - 2 * d + 4 * h });
  add('k3', { who: 'kim', created: now - 5 * h, assigned: now - 5 * h, subject: 'Refund please' });
  add('k0', { who: 'kim', done: true, created: now - 60 * d, assigned: now - 60 * d, finished: now - 59 * d });
  // Lee: three finished (1, 2 and 9 hours: median 2), none open.
  for (const [i, hrs] of [[1, 1], [2, 2], [3, 9]]) add(`l${i}`, { who: 'lee', done: true, created: now - d, assigned: now - d, finished: now - d + hrs * h });
  // Nobody's: one finished without being given to anyone, two waiting (the oldest first in the list).
  add('n1', { done: true, created: now - 4 * d, finished: now - 4 * d + h });
  add('n2', { created: now - 10 * d, subject: 'Invoice question' });
  add('n3', { created: now - 2 * h, subject: 'Login trouble' });
  const r = sharedReport('mb', 30, now);
  assert.deepEqual(r.people, [
    { id: 'kim', name: 'Kim Park', open: 1, done: 2, median_hours: 3 },
    { id: 'lee', name: 'Lee Fox', open: 0, done: 3, median_hours: 2 },
    { id: 'max', name: 'Max Moss', open: 0, done: 0, median_hours: null },
  ]);
  assert.equal(r.done_unassigned, 1);
  assert.equal(r.not_done, 3);
  assert.equal(r.unassigned, 2);
  assert.deepEqual(r.oldest.map((o) => [o.subject, o.assignee]), [['Invoice question', null], ['Refund please', 'Kim Park'], ['Login trouble', null]]);
  assert.equal(sharedReport('mb', 7, now).people[0].done, 2, 'both within the week');
  assert.equal(sharedReport('mb', 90, now).people[0].done, 3, 'the one from two months ago is in 90 days');
});
