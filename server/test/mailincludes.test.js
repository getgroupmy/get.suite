import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-includes-db-')); // a database of its own
const { recordTogether, suggestIncludes, MAX_GROUP } = await import('../src/mail/includes.js');
const { q } = await import('../src/db.js');

q("INSERT INTO orgs (id, name, created_at) VALUES ('iorg', 'I Org', 0) ON CONFLICT DO NOTHING").run();
const person = (id) => { q("INSERT INTO users (id, org_id, username, name, password_hash, created_at) VALUES (?, 'iorg', ?, ?, 'x', 0)").run(id, `${id}@acme.com`, id); return { id, username: `${id}@acme.com` }; };
const to = (...xs) => xs.map((x) => (typeof x === 'string' ? { address: x } : x));

test('include: whoever is usually on mail with those you are writing to, likeliest first', () => {
  const me = person('inc1');
  for (let i = 0; i < 3; i++) recordTogether(me, to({ address: 'Kim@Acme.com', name: 'Kim Park' }, 'lee@acme.com', 'inc1@acme.com'));
  recordTogether(me, to('kim@acme.com', 'pat@partner.example')); // once is not enough
  recordTogether(me, to('kim@acme.com')); // on her own: 5 messages to Kim, 3 with Lee
  assert.deepEqual(suggestIncludes(me, ['KIM@acme.com']), [{ email: 'lee@acme.com', name: null, times: 3 }]);
  assert.deepEqual(suggestIncludes(me, ['lee@acme.com']), [{ email: 'kim@acme.com', name: 'Kim Park', times: 3 }], 'with the name last written');
  assert.deepEqual(suggestIncludes(me, ['kim@acme.com', 'lee@acme.com']), [], 'already on it');
  assert.deepEqual(suggestIncludes(me, ['kim@acme.com'], { not: ['lee@acme.com'] }), [], 'waved away');
  assert.deepEqual(suggestIncludes(me, ['inc1@acme.com']), [], 'not yourself');
  assert.deepEqual(suggestIncludes(me, ['nobody@acme.com']), []);
  assert.deepEqual(suggestIncludes(person('inc2'), ['kim@acme.com']), [], 'each person their own');
});

test('include: across several people on the message, on average at least half', () => {
  const me = person('inc3');
  for (let i = 0; i < 4; i++) recordTogether(me, to('a@x.example', 'team@x.example'));
  for (let i = 0; i < 4; i++) recordTogether(me, to('b@x.example'));
  recordTogether(me, to('b@x.example', 'team@x.example'));
  assert.deepEqual(suggestIncludes(me, ['a@x.example']).map((s) => s.email), ['team@x.example']);
  // a: 4/4 with team, b: 1/5 -> (1 + 0.2) / 2 = 0.6
  assert.deepEqual(suggestIncludes(me, ['a@x.example', 'b@x.example']).map((s) => s.email), ['team@x.example']);
  recordTogether(me, to('b@x.example')); recordTogether(me, to('b@x.example')); recordTogether(me, to('b@x.example'));
  recordTogether(me, to('a@x.example')); recordTogether(me, to('a@x.example')); recordTogether(me, to('a@x.example')); recordTogether(me, to('a@x.example'));
  // a: 4/8, b: 1/8 -> 0.31
  assert.deepEqual(suggestIncludes(me, ['a@x.example', 'b@x.example']), []);
});

test('include: big mailings do not pair everyone; at most three suggestions', () => {
  const me = person('inc4');
  const crowd = Array.from({ length: MAX_GROUP + 1 }, (_, i) => `c${i}@x.example`);
  for (let i = 0; i < 3; i++) recordTogether(me, to(...crowd));
  assert.deepEqual(suggestIncludes(me, ['c0@x.example']), []);
  for (let i = 0; i < 3; i++) recordTogether(me, to('p@x.example', 'q1@x.example', 'q2@x.example', 'q3@x.example', 'q4@x.example'));
  assert.equal(suggestIncludes(me, ['p@x.example']).length, 3);
});

test('frequently contacted: most emailed first, then latest; contacts and colleagues named; older than the window left out', async () => {
  const { frequentOf } = await import('../src/mail/includes.js');
  const me = { ...person('inc5'), org_id: 'iorg' };
  person('freqcol');
  q("INSERT INTO contacts (id, owner_id, name, email, created_at) VALUES ('fc1', 'inc5', 'Sam Client', 'sam@client.example', 0)").run();
  const day = 864e5, now = Date.now();
  for (let i = 0; i < 3; i++) recordTogether(me, [{ address: 'sam@client.example' }], now - day);
  for (let i = 0; i < 3; i++) recordTogether(me, [{ address: 'freqcol@acme.com' }], now - 2 * day);
  recordTogether(me, [{ address: 'pat@partner.example', name: 'Pat P' }], now);
  for (let i = 0; i < 9; i++) recordTogether(me, [{ address: 'old@x.example' }], now - 400 * day);
  const f = frequentOf(me, { now });
  assert.deepEqual(f.map((x) => [x.email, x.times]), [['sam@client.example', 3], ['freqcol@acme.com', 3], ['pat@partner.example', 1]]);
  assert.equal(f[0].name, 'Sam Client'); assert.equal(f[0].contact_id, 'fc1');
  assert.equal(f[1].name, 'freqcol'); assert.equal(f[1].colleague_id, 'freqcol');
  assert.equal(f[2].name, 'Pat P'); assert.equal(f[2].contact_id, null);
  assert.deepEqual(frequentOf({ ...person('inc6'), org_id: 'iorg' }), []);
});
