import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-people-'));
const { createApp } = await import('../src/app.js');

let server, base;
test.before(async () => { server = createApp().listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

test('people with access, to email them: owner, people, a group, a folder’s shares; not oneself; editors only', async () => {
  const olivia = client(), kim = client(), vic = client();
  await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' });
  const ids = {};
  for (const [local, name] of [['kim', 'Kim Park'], ['vic', 'Vic Viewer'], ['gail', 'Gail Group'], ['fred', 'Fred Folder'], ['ned', 'Ned Nobody']]) {
    ids[local] = (await olivia('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).body.id;
  }
  await kim('POST', '/api/auth/login', { username: 'kim@acme.com', password: 'password123' });
  await vic('POST', '/api/auth/login', { username: 'vic@acme.com', password: 'password123' });
  const folder = (await olivia('POST', '/api/files/folder', { name: 'Project' })).body;
  const doc = (await olivia('POST', '/api/files/new', { kind: 'doc', name: 'Plan', parent_id: folder.id })).body;
  await olivia('PUT', `/api/files/${folder.id}/shares`, { shares: [{ user_id: ids.fred, role: 'viewer' }] });
  await olivia('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: ids.kim, role: 'editor' }, { user_id: ids.vic, role: 'viewer' }] });
  const g = (await olivia('POST', '/api/groups', { name: 'Design' })).body;
  await olivia('PUT', `/api/groups/${g.id}/members`, { user_ids: [ids.gail] });
  await olivia('PUT', `/api/files/${doc.id}/groups`, { groups: [{ group_id: g.id, role: 'commenter' }] });
  const names = (r) => r.body.people.map((p) => p.name);
  const mine = await olivia('GET', `/api/files/${doc.id}/people`);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.deepEqual(names(mine), ['Fred Folder', 'Gail Group', 'Kim Park', 'Vic Viewer']);
  assert.equal(mine.body.people.find((p) => p.name === 'Kim Park').username, 'kim@acme.com');
  assert.equal(mine.body.everyone_at_company, false);
  // An editor gets the owner and the rest, not themselves; a viewer can't ask.
  assert.deepEqual(names(await kim('GET', `/api/files/${doc.id}/people`)), ['Fred Folder', 'Gail Group', 'Olivia Owner', 'Vic Viewer']);
  assert.equal((await vic('GET', `/api/files/${doc.id}/people`)).status, 403);
  // Shared with everyone at the company: said, not everyone listed.
  await olivia('PUT', `/api/files/${doc.id}/company`, { role: 'viewer' });
  const all = (await olivia('GET', `/api/files/${doc.id}/people`)).body;
  assert.equal(all.everyone_at_company, true);
  assert.ok(!all.people.some((p) => p.name === 'Ned Nobody'));
});
