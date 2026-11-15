import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-known-'));
const { createApp } = await import('../src/app.js');
createApp(); // every module's tables
const { q } = await import('../src/db.js');
const { createOrg } = await import('../src/tenancy.js');
const { knownSendersMap, buildMailConfig } = await import('../src/mail/config.js');

test('known senders: addresses written to and contacts, not the company’s own, once each', () => {
  const { userId } = createOrg({ name: 'Acme', domain: 'acme.com', adminName: 'Ana', adminLocal: 'ana', adminPassword: 'password123' });
  const t = Date.now();
  q('INSERT INTO mail_sent_to (owner_id, email, name, times, last_at) VALUES (?, ?, ?, ?, ?)').run(userId, 'Billing@Initech.com', 'Billing', 5, t);
  q('INSERT INTO mail_sent_to (owner_id, email, name, times, last_at) VALUES (?, ?, ?, ?, ?)').run(userId, 'kim@acme.com', 'Kim', 9, t);
  q("INSERT INTO contacts (id, owner_id, name, email, created_at) VALUES ('c1', ?, 'Grace', 'grace@example.org', ?)").run(userId, t);
  q("INSERT INTO contacts (id, owner_id, name, email, created_at) VALUES ('c2', ?, 'Billing', 'billing@initech.com', ?)").run(userId, t);
  q("INSERT INTO contacts (id, owner_id, name, email, created_at) VALUES ('c3', ?, 'Odd', 'not an address', ?)").run(userId, t);
  const lines = knownSendersMap().split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(lines, ['billing@initech.com', 'grace@example.org']);
  assert.equal(buildMailConfig()['rspamd/known_senders.map'], knownSendersMap(), 'written with the rest of the mail setup');
});

test('blockProgramsMap: the domains of companies that refuse programs by email', async () => {
  const { blockProgramsMap } = await import('../src/mail/config.js');
  const { q } = await import('../src/db.js');
  blockProgramsMap(); // the column
  q("INSERT INTO orgs (id, name, created_at, block_programs) VALUES ('bp1', 'Strict', 0, 1), ('bp2', 'Relaxed', 0, 0)").run();
  q("INSERT INTO domains (name, org_id, created_at) VALUES ('strict.example', 'bp1', 0), ('strict-two.example', 'bp1', 0), ('relaxed.example', 'bp2', 0)").run();
  const lines = blockProgramsMap().split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(lines, ['strict-two.example', 'strict.example']);
});
