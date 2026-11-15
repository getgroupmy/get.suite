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

test('an admin’s own practice email: name, subject and text with {link}; checked', async () => {
  const sent = [];
  const r = await sendPractice(ana, { template: 'custom', userIds: ['k'], base: 'https://ws', custom: { from: 'DHL Express <x>', subject: 'Parcel held at customs', text: 'Pay RM 3.50 to release it: {link}\nThanks' } }, { send: async (m) => sent.push(m) });
  assert.equal(r.sent, 1);
  assert.deepEqual(sent[0].from, { name: 'DHL Express x', address: 'ana@acme.com' }, 'no address tricks in the name');
  assert.match(sent[0].text, /^Pay RM 3\.50 to release it: https:\/\/ws\/practice\/[\w-]+\nThanks$/);
  assert.equal(practiceFor('o1')[0].name, 'Custom: Parcel held at customs');
  const s2 = [];
  await sendPractice(ana, { template: 'custom', userIds: ['k'], base: 'https://ws', custom: { from: 'HR', subject: 'Bonus', text: 'See your bonus' } }, { send: async (m) => s2.push(m) });
  assert.match(s2[0].text, /^See your bonus\n\nhttps:\/\/ws\/practice\//, 'link added when {link} is missing');
  await assert.rejects(sendPractice(ana, { template: 'custom', userIds: ['k'], base: 'x', custom: { subject: 'x', text: 'y' } }), /pretends to be from/);
  await assert.rejects(sendPractice(ana, { template: 'custom', userIds: ['k'], base: 'x', custom: { from: 'x', text: 'y' } }), /subject/);
});

test('automatic rounds: due every N months from the last round, to a random third, as the admin who set it', async () => {
  const { setAutoPractice, autoPracticeOf, autoPracticeTick } = await import('../src/phishpractice.js');
  for (let i = 0; i < 6; i++) q("INSERT INTO users (id, org_id, username, name, password_hash, created_at) VALUES (?, 'o1', ?, ?, 'x', 0)").run(`p${i}`, `p${i}@acme.com`, `Person ${i}`);
  assert.throws(() => setAutoPractice(ana, 2), /Every 1, 3 or 6 months/);
  assert.deepEqual(autoPracticeOf('o1').every, 0);
  const sent = [];
  const send = async (m) => sent.push(m);
  assert.deepEqual(await autoPracticeTick(Date.now(), { base: 'https://ws', send }), [], 'off');
  const auto = setAutoPractice(ana, 3);
  assert.equal(auto.every, 3); assert.equal(auto.by, 'Ana Admin');
  const last = autoPracticeOf('o1').last_at;
  assert.deepEqual(await autoPracticeTick(last + 10 * 864e5, { base: 'https://ws', send }), [], 'not due yet: a round went out lately');
  assert.deepEqual(await autoPracticeTick(last + 91 * 864e5, { base: 'https://ws', send, pick: () => 0.5 }), ['o1']);
  const active = q("SELECT COUNT(*) AS n FROM users WHERE org_id = 'o1' AND disabled = 0").get().n;
  assert.equal(sent.length, Math.round(active / 3));
  assert.ok(sent.every((m) => m.from.address === 'ana@acme.com'));
  assert.deepEqual(await autoPracticeTick(Date.now() + 1000, { base: 'https://ws', send }), [], 'just sent');
  assert.deepEqual(await autoPracticeTick(Date.now() + 200 * 864e5, { base: '', send }), [], 'no server address: waits');
  q("UPDATE users SET disabled = 1 WHERE id = 'a'").run();
  assert.deepEqual(await autoPracticeTick(Date.now() + 200 * 864e5, { base: 'https://ws', send }), [], 'the admin left: waits');
  q("UPDATE users SET disabled = 0 WHERE id = 'a'").run();
  setAutoPractice(ana, 0);
  assert.equal(autoPracticeOf('o1').next_at, null);
});
