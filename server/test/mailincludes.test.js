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
