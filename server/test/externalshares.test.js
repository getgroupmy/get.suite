import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-extshares-'));
const { createApp } = await import('../src/app.js');
const { q } = await import('../src/db.js');

let server, base;
test.before(async () => { server = createApp().listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
function client() {
  let cookie = '';
  return async (method, url, body, raw) => {
    const r = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', ...(!raw && { 'content-type': 'application/json' }), ...(cookie && { cookie }) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: json, text, type: r.headers.get('content-type') };
  };
}
const ana = client(), kim = client(), gil = client(), ivy = client();
const id = (u) => q('SELECT id FROM users WHERE username = ?').get(u).id;

test('Admin → Shared outside: what the company shares with other companies, and stopping it', async () => {
  await ana('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ana Admin', local: 'ana', password: 'password123' });
  await ana('POST', '/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const globex = (await ana('POST', '/api/orgs', { name: 'Globex', domain: 'globex.com', admin_name: 'Gil', admin_local: 'gil', admin_password: 'password123' })).body;
  const initech = (await ana('POST', '/api/orgs', { name: 'Initech', domain: 'initech.com', admin_name: 'Ivy', admin_local: 'ivy', admin_password: 'password123' })).body;
  for (const [c, u] of [[kim, 'kim@acme.com'], [gil, 'gil@globex.com'], [ivy, 'ivy@initech.com']]) await c('POST', '/api/auth/login', { username: u, password: 'password123' });
  const folder = (await kim('POST', '/api/files/folder', { name: 'Joint project' })).body;
  const plan = (await kim('POST', '/api/files/upload?name=plan.txt', 'the plan', true)).body;
  const memo = (await kim('POST', '/api/files/upload?name=memo.txt', 'internal', true)).body;
  assert.equal((await kim('PUT', `/api/files/${folder.id}/shares`, { shares: [{ user_id: id('gil@globex.com'), role: 'editor' }] })).status, 200);
  assert.equal((await kim('PUT', `/api/files/${plan.id}/shares`, { shares: [{ user_id: id('gil@globex.com'), role: 'viewer' }, { user_id: id('ivy@initech.com'), role: 'viewer' }] })).status, 200);
  assert.equal((await kim('PUT', `/api/files/${memo.id}/shares`, { shares: [{ user_id: id('ana@acme.com'), role: 'editor' }] })).status, 200);

  assert.equal((await kim('GET', '/api/external-shares')).status, 403, 'admins only');
  const r = (await ana('GET', '/api/external-shares')).body;
  assert.deepEqual(r.items.map((x) => [x.with_company, x.file_name, x.with_email, x.role, x.owner_name]), [
    ['Globex', 'Joint project', 'gil@globex.com', 'editor', 'Kim Park'],
    ['Globex', 'plan.txt', 'gil@globex.com', 'viewer', 'Kim Park'],
    ['Initech', 'plan.txt', 'ivy@initech.com', 'viewer', 'Kim Park'],
  ], 'not the memo shared inside the company');
  assert.deepEqual(r.companies.map((c) => [c.name, c.items, c.people]), [['Globex', 2, 1], ['Initech', 1, 1]]);
  // Globex's admin sees nothing of Acme's (it's what *their* company shares out).
  assert.deepEqual((await gil('GET', '/api/external-shares')).body.items, []);

  // The security checkup points here.
  const { checkup } = await import('../src/checkup.js');
  const orgId = q("SELECT org_id FROM users WHERE username = 'ana@acme.com'").get().org_id;
  const item = (await checkup(orgId, Date.now(), { mail: false })).find((x) => x.id === 'outside');
  assert.equal(item.title, '2 files and folders shared with people at 2 other companies');
  assert.match(item.detail, /^Globex, Initech; 1 of them they can edit\./);
  assert.equal(item.tab, 'outside');
  // A spreadsheet of it, for an audit; admins only.
  const csv = await ana('GET', '/api/external-shares/export.csv');
  assert.match(csv.type, /text\/csv/);
  const lines = csv.text.replace(/^\ufeff/, '').trim().split('\r\n');
  assert.equal(lines[0], 'File or folder,Kind,Shared by,Their email,With,Email,Company,Access,Until (UTC),In the trash');
  assert.equal(lines.length, 4);
  assert.equal(lines[1], 'Joint project,folder,Kim Park,kim@acme.com,Gil,gil@globex.com,Globex,Can edit,,no');
  assert.equal((await kim('GET', '/api/external-shares/export.csv')).status, 403);
  // Stop one: Ivy can't open the plan any more; Kim is told.
  assert.equal((await ivy('GET', `/api/files/${plan.id}/raw`)).status, 200);
  assert.equal((await ana('DELETE', `/api/external-shares/${plan.id}/${id('ivy@initech.com')}`)).status, 200);
  assert.equal((await ivy('GET', `/api/files/${plan.id}/raw`)).status, 404);
  assert.equal((await ana('DELETE', `/api/external-shares/${plan.id}/${id('ivy@initech.com')}`)).status, 404, 'gone already');
  assert.ok(q("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'An admin stopped sharing “plan.txt” outside the company'").get(id('kim@acme.com')));
  // An inside share can't be stopped this way.
  assert.equal((await ana('DELETE', `/api/external-shares/${memo.id}/${id('ana@acme.com')}`)).status, 404);

  // Stop everything with Globex.
  assert.equal((await ana('POST', '/api/external-shares/stop-company', { org_id: globex.id })).body.stopped, 2);
  assert.equal((await gil('GET', `/api/files/${folder.id}`)).status, 404);
  assert.deepEqual((await ana('GET', '/api/external-shares')).body.items, []);
  assert.equal((await ana('POST', '/api/external-shares/stop-company', { org_id: initech.id })).status, 404);
  assert.equal((await ana('GET', `/api/files/${memo.id}`)).status, 200, 'inside shares untouched');
  // In the activity log, in words.
  const log = (await ana('GET', '/api/audit?action=file')).body.entries;
  assert.ok(log.some((e) => e.label === 'Changed sharing' && e.details?.by_admin && e.details?.company));
});
