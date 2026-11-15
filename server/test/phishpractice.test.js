import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-practice-'));
const { q } = await import('../src/db.js');
const { sendPractice, practiceClicked, practiceReported, practiceFor, practicePage, TEMPLATES } = await import('../src/phishpractice.js');

q("INSERT INTO orgs (id, name, created_at) VALUES ('o1', 'Acme', 0), ('o2', 'Other', 0)").run();
for (const [id, org, u, n] of [['a', 'o1', 'ana@acme.com', 'Ana Admin'], ['k', 'o1', 'kim@acme.com', 'Kim Park'], ['l', 'o1', 'lee@acme.com', 'Lee Chen'], ['x', 'o2', 'x@other.com', 'Xan']]) {
  q("INSERT INTO users (id, org_id, username, name, password_hash, created_at, is_admin) VALUES (?, ?, ?, ?, 'x', 0, ?)").run(id, org, u, n, id === 'a' ? 1 : 0);
}
const ana = { id: 'a', org_id: 'o1', username: 'ana@acme.com' };

test('a practice round: one email each, from the admin under a made-up name, with its own link and Message-ID', async () => {
  const sent = [];
  const r = await sendPractice(ana, { template: 'password', userIds: ['k', 'l', 'x'], base: 'https://ws.acme.com/' }, { send: async (m) => { sent.push(m); } });
  assert.equal(r.sent, 2, 'not someone at another company');
  assert.deepEqual(sent.map((m) => m.to), ['kim@acme.com', 'lee@acme.com']);
  assert.deepEqual(sent[0].from, { name: 'IT Helpdesk', address: 'ana@acme.com' });
  assert.equal(sent[0].subject, TEMPLATES.password.subject);
  const token = /\/practice\/([\w-]+)/.exec(sent[0].text)[1];
  assert.equal(sent[0].messageId, `<practice.${token}@workspace>`);
  assert.match(sent[0].text, /^Hello,[\s\S]*https:\/\/ws\.acme\.com\/practice\//);

  // Kim clicks; Lee reports it (only their own copy counts); someone else's report of Kim's copy doesn't.
  assert.deepEqual(practiceClicked(token), { name: 'Kim Park', template: 'password' });
  const leeToken = /\/practice\/([\w-]+)/.exec(sent[1].text)[1];
  assert.equal(practiceReported({ id: 'k' }, `<practice.${leeToken}@workspace>`), false);
  assert.equal(practiceReported({ id: 'l' }, `<practice.${leeToken}@workspace>`), true);
  assert.equal(practiceReported({ id: 'l' }, '<an-ordinary-message@x>'), false);
  const round = practiceFor('o1')[0];
  assert.deepEqual([round.sent, round.clicked, round.reported], [2, 1, 1]);
  assert.deepEqual(round.people.map((p) => [p.name, !!p.clicked_at, !!p.reported_at]), [['Kim Park', true, false], ['Lee Chen', false, true]]);
  assert.deepEqual(practiceFor('o2'), [], 'only the company’s own');
});

test('a failed send is noted; unknown templates and nobody chosen are refused; the page escapes names', async () => {
  const r = await sendPractice(ana, { template: 'invoice', userIds: ['k'], base: 'https://x' }, { send: async () => { throw new Error('mailbox full'); } });
  assert.deepEqual([r.sent, r.failed], [0, 1]);
  assert.equal(practiceFor('o1')[0].people[0].error, 'mailbox full');
  await assert.rejects(sendPractice(ana, { template: 'nope', userIds: ['k'], base: 'x' }), /Choose which practice email/);
  await assert.rejects(sendPractice(ana, { template: 'invoice', userIds: [], base: 'x' }), /Choose who gets it/);
  assert.equal(practiceClicked('unknown'), null);
  assert.match(practicePage({ name: '<b>Kim</b>' }), /&lt;b&gt;Kim&lt;\/b&gt;/);
  assert.match(practicePage(null), /This was a practice phishing email/);
});
