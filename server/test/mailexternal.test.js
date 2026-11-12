import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-external-db-')); // a database of its own
const { recordTogether } = await import('../src/mail/includes.js');
const { outsideRecipients } = await import('../src/mail/external.js');
const { q } = await import('../src/db.js');

q("INSERT INTO orgs (id, name, created_at) VALUES ('xorg', 'Acme', 0)").run();
for (const d of ['acme.com', 'acme.co.uk']) q("INSERT INTO domains (name, org_id, created_at) VALUES (?, 'xorg', 0)").run(d);
q("INSERT INTO users (id, org_id, username, name, password_hash, created_at) VALUES ('xu', 'xorg', 'olivia@acme.com', 'Olivia', 'x', 0)").run();
const me = { id: 'xu', org_id: 'xorg', username: 'olivia@acme.com' };

test('outside: addresses not on the company’s domains; new ones are those never written to and not in contacts', () => {
  recordTogether(me, [{ address: 'pat@partner.example' }]);
  q("INSERT INTO contacts (id, owner_id, name, email, created_at, more_emails) VALUES ('c1', 'xu', 'Sam', 'sam@client.example', 0, ?)").run(JSON.stringify([{ type: 'home', value: 'sam@home.example' }]));
  assert.deepEqual(outsideRecipients(me, ['kim@acme.com', 'Lee@ACME.co.uk', 'PAT@partner.example', 'sam@client.example', 'sam@home.example', 'new@stranger.example', 'new@stranger.example']), [
    { email: 'pat@partner.example', new: false },
    { email: 'sam@client.example', new: false },
    { email: 'sam@home.example', new: false },
    { email: 'new@stranger.example', new: true },
  ]);
  assert.deepEqual(outsideRecipients(me, ['kim@acme.com', 'not-an-address', '']), []);
  assert.deepEqual(outsideRecipients(me, ['x@sub.acme.com']), [{ email: 'x@sub.acme.com', new: true }], 'only the domains themselves');
});
