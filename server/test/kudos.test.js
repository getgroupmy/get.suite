// Focus sessions on tasks: a timer that stops by itself, counted to its end, with a note to its owner.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-kudos-'));
process.env.DATA_DIR = dir;
let server, base;
before(async () => {
  const { createApp } = await import('../src/app.js');
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}


const login = async (username) => { const c = client(); const r = await c('POST', '/api/auth/login', { username, password: 'password123' }); assert.equal(r.status, 200, JSON.stringify(r.body)); c.user = r.body.user; return c; };

test('thanks: given to a colleague, who is told; on their card and the company’s list; taken back by its giver', async () => {
  assert.equal((await client()('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  const olivia = await login('olivia@acme.com');
  const made = await olivia('POST', '/api/users', { local: 'tara', domain: 'acme.com', name: 'Tara Thanks', password: 'password123' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const tara = await login('tara@acme.com');
  const taraId = tara.user.id, me = olivia.user;

  assert.equal((await olivia('POST', '/api/kudos', { to: taraId, message: '' })).status, 400, 'says what for');
  assert.equal((await olivia('POST', '/api/kudos', { to: me.id, message: 'Me' })).status, 400, 'not yourself');
  assert.equal((await olivia('POST', '/api/kudos', { to: 'nobody', message: 'Hi' })).status, 404);
  const k = await olivia('POST', '/api/kudos', { to: taraId, message: 'Thanks for covering the launch call', emoji: '🚀' });
  assert.equal(k.status, 201);
  assert.deepEqual([k.body.emoji, k.body.to_name, k.body.from_name, k.body.mine], ['🚀', 'Tara Thanks', 'Olivia Owner', true]);
  assert.equal((await olivia('POST', '/api/kudos', { to: taraId, message: 'Again', emoji: '💩' })).body.emoji, '🙌', 'only the offered emoji');

  const bell = (await tara('GET', '/api/notifications')).body;
  const items = bell.items || bell.notifications || bell;
  assert.ok(items.some((n) => n.kind === 'kudos' && /thanked you/.test(n.title) && n.body === 'Thanks for covering the launch call'), JSON.stringify(items).slice(0, 300));

  const card = (await tara('GET', `/api/kudos/for/${taraId}`)).body;
  assert.equal(card.count, 2);
  assert.equal(card.latest[0].message, 'Again');
  assert.equal(card.latest[1].mine, false, 'not Tara’s own');
  const wall = (await tara('GET', '/api/kudos?limit=5')).body;
  assert.equal(wall[0].to_name, 'Tara Thanks');

  // 👏: anyone but its giver, once each; off again.
  assert.equal((await olivia('POST', `/api/kudos/${k.body.id}/clap`, {})).status, 400, 'not on your own');
  const c1 = (await tara('POST', `/api/kudos/${k.body.id}/clap`, {})).body;
  assert.deepEqual([c1.claps, c1.clapped, c1.clappers], [1, true, ['Tara Thanks']]);
  assert.equal((await tara('POST', `/api/kudos/${k.body.id}/clap`, {})).body.claps, 1, 'once each');
  const seen = (await olivia('GET', '/api/kudos')).body.find((x) => x.id === k.body.id);
  assert.deepEqual([seen.claps, seen.clapped], [1, false]);
  assert.equal((await tara('POST', `/api/kudos/${k.body.id}/clap`, { on: false })).body.claps, 0);
  assert.equal((await tara('POST', '/api/kudos/nope/clap', {})).status, 404);
  await tara('POST', `/api/kudos/${k.body.id}/clap`, {});
  assert.equal((await tara('DELETE', `/api/kudos/${k.body.id}`)).status, 404, 'only its giver');
  assert.equal((await olivia('DELETE', `/api/kudos/${k.body.id}`)).status, 200);
  assert.equal((await tara('GET', `/api/kudos/for/${taraId}`)).body.count, 1);

  // A daily limit: 20 a day (the one taken back no longer counts).
  for (let i = 0; i < 19; i++) await olivia('POST', '/api/kudos', { to: taraId, message: `#${i}` });
  assert.equal((await olivia('POST', '/api/kudos', { to: taraId, message: 'one more' })).status, 400);
});
