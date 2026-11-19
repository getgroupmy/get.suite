// Calendar's look (the week's first day, weekends, week numbers) is kept with your account, not in one browser:
// unchosen until set, only the values the views offer, and changed one at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCalPrefs } from '../src/calprefs.js';

test('not chosen yet: null, so a browser’s earlier choice can be kept', () => {
  const p = cleanCalPrefs(null);
  assert.deepEqual([p.weekStart, p.weekends, p.weekNumbers], [null, null, null]);
});

test('only Sunday, Monday or Saturday, and true or false', () => {
  assert.equal(cleanCalPrefs({ weekStart: 1 }).weekStart, 1);
  assert.equal(cleanCalPrefs({ weekStart: 6 }).weekStart, 6);
  for (const bad of [3, '1', -1, 7, 'monday']) assert.equal(cleanCalPrefs({ weekStart: bad }).weekStart, null, String(bad));
  assert.deepEqual([cleanCalPrefs({ weekends: false }).weekends, cleanCalPrefs({ weekNumbers: true }).weekNumbers], [false, true]);
  assert.equal(cleanCalPrefs({ weekends: 'no' }).weekends, null);
});

test('saved through the settings call, one at a time, the rest kept', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const http = await import('node:http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-calview-'));
  process.env.DATA_DIR = dir;
  const { createApp } = await import('../src/app.js');
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    await call('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' });
    assert.equal((await call('PUT', '/api/users/me/calendar-prefs', { length: 30 })).status, 200);
    const a = (await call('PUT', '/api/users/me/calendar-prefs', { weekStart: 1 })).body;
    assert.deepEqual([a.weekStart, a.length, a.weekends], [1, 30, null]);
    const b = (await call('PUT', '/api/users/me/calendar-prefs', { weekends: false, weekNumbers: true })).body;
    assert.deepEqual([b.weekStart, b.weekends, b.weekNumbers], [1, false, true]);
    const me = (await call('GET', '/api/auth/me')).body.user;
    assert.deepEqual([me.cal_prefs.weekStart, me.cal_prefs.weekends, me.cal_prefs.weekNumbers], [1, false, true], 'given to every browser at sign-in');
  } finally { server.closeAllConnections?.(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
