import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-incoming-'));
const { createOrg } = await import('../src/tenancy.js');
const { incomingWarning } = await import('../src/mail/external.js');
const { q } = await import('../src/db.js');

test('mail from outside: marked when the company wants it; a colleague’s name from outside always warned', () => {
  const { id: orgId, userId } = createOrg({ name: 'Acme', domain: 'acme.com', adminName: 'Ana Silva', adminLocal: 'ana', adminPassword: 'password123' });
  q("UPDATE users SET name = 'Ana Silva' WHERE id = ?").run(userId);
  const ana = q('SELECT * FROM users WHERE id = ?').get(userId);
  const from = (name, address) => incomingWarning(ana, { name, address });

  // Off (the default): only a look-alike name is warned about.
  assert.equal(from('Kim', 'kim@acme.com'), null, 'colleagues');
  assert.equal(from('Gina', 'gina@globex.com'), null);
  assert.deepEqual(from('Ana  Silva', 'ana.silva.ceo@gmail.com'), { company: 'Acme', external: false, lookalike: 'Ana Silva', address: 'ana.silva.ceo@gmail.com' });
  assert.equal(from('"ANA SILVA"', 'x@gmail.com').lookalike, 'Ana Silva', 'case, quotes and spaces don’t matter');
  assert.equal(from('Ana Silva', 'ana@acme.com'), null, 'the real one');
  assert.equal(from('An', 'x@gmail.com'), null, 'too short a name to compare');

  // On: everything from outside is marked.
  q('UPDATE orgs SET mark_external = 1 WHERE id = ?').run(orgId);
  assert.deepEqual(from('Gina', 'Gina@Globex.com'), { company: 'Acme', external: true, lookalike: null, address: 'gina@globex.com' });
  assert.equal(from('Kim', 'kim@acme.com'), null);
  assert.equal(from(null, null), null);
  // A suspended colleague's name doesn't count.
  q("UPDATE users SET disabled = 1 WHERE id = ?").run(userId);
  assert.equal(from('Ana Silva', 'x@gmail.com').lookalike, null);
});
