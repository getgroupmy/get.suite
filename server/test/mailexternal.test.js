import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-external-db-')); // a database of its own
const { recordTogether } = await import('../src/mail/includes.js');
const { outsideRecipients, replyToWarning } = await import('../src/mail/external.js');
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

test('replyToWarning: replies that would go to another site than the email came from', () => {
  const w = (from, rt, o) => replyToWarning(me, { address: from }, rt.map((address) => ({ address })), o);
  assert.deepEqual(w('ceo@supplier.example', ['Ceo.Supplier@gmail.example']), { from: 'ceo@supplier.example', reply_to: 'ceo.supplier@gmail.example' });
  assert.equal(w('ceo@supplier.example', []), null, 'no Reply-To');
  assert.equal(w('ceo@supplier.example', ['billing@mail.supplier.example']), null, 'the same site');
  assert.equal(w('news@shop.example', ['help@desk.example'], { list: true }), null, 'a mailing list');
  assert.equal(w('kim@partner.example', ['team@acme.com']), null, 'answers come to the company');
  assert.equal(w('kim@partner.example', ['pat@partner.example', 'sam@client.example']), null, 'someone you deal with (a contact)');
  assert.deepEqual(w('ana@acme.com', ['ana.acme@freemail.example']), { from: 'ana@acme.com', reply_to: 'ana.acme@freemail.example' }, 'a colleague’s name with replies outside');
});

test('isFirstContact: never for colleagues, people written to or contacts, or when the mailbox can’t be asked', async () => {
  const { isFirstContact } = await import('../src/mail/firstcontact.js');
  assert.equal(await isFirstContact(me, 'kim@acme.com'), false, 'a colleague');
  assert.equal(await isFirstContact(me, 'PAT@partner.example'), false, 'written to');
  assert.equal(await isFirstContact(me, 'sam@client.example'), false, 'a contact');
  assert.equal(await isFirstContact(me, 'not an address'), false);
  assert.equal(await isFirstContact(me, 'new@stranger.example'), false, 'no mail server here: says nothing rather than guess');
});

test('outsideRecipients: a new address on a lookalike of the company’s domain or a known one is marked', () => {
  const list = outsideRecipients(me, ['billing@acrne.com', 'pat@partner.example', 'x@partmer.example', 'new@unrelated-shop.example']);
  const by = Object.fromEntries(list.map((o) => [o.email, o.like || null]));
  assert.deepEqual(by['billing@acrne.com'], { domain: 'acme.com', kind: 'company' });
  assert.equal(by['pat@partner.example'], null, 'someone you write to');
  assert.equal(by['x@partmer.example']?.domain, 'partner.example');
  assert.equal(by['new@unrelated-shop.example'], null);
});
