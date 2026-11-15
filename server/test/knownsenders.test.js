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
