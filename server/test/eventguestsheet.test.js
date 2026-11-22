// Calendar → Guest list in Sheets: who is invited to your event and how they answered, as a spreadsheet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-guestsheet-'));
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

test('an event’s guest list as a spreadsheet: the organizer first, each guest’s answer and note; only for the organizer', async () => {
  const ann = client(), ben = client(), cy = client();
  assert.equal((await ann('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ann Owner', local: 'ann', password: 'password123' })).status, 200);
  for (const [who, local, name] of [[ben, 'ben', 'Ben Bell'], [cy, 'cy', 'Cy Cole']]) {
    assert.equal((await ann('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).status, 201);
    assert.equal((await who('POST', '/api/auth/login', { username: `${local}@acme.com`, password: 'password123' })).status, 200);
  }
  const t0 = Date.now() + 864e5;
  const alone = (await ann('POST', '/api/events', { title: 'Focus', start: t0, end: t0 + 36e5 })).body;
  assert.equal((await ann('POST', `/api/events/${alone.id}/guests-sheet`, {})).status, 400, 'no guests');
  const ev = (await ann('POST', '/api/events', { title: 'Offsite', start: t0, end: t0 + 36e5, guests: ['ben@acme.com', 'cy@acme.com'] })).body;
  assert.equal((await ben('POST', `/api/events/${ev.id}/rsvp`, { status: 'yes', note: 'Bringing snacks' })).status, 200);
  const r = await ann('POST', `/api/events/${ev.id}/guests-sheet`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.guests], ['Offsite (guests)', 2]);
  const sh = (await ann('GET', `/api/files/${r.body.id}/content`)).body.content.sheets[0];
  const row = (n) => ['A', 'B', 'C', 'D', 'E'].map((c) => sh.cells[`${c}${n}`] || '');
  assert.deepEqual(row(1), ['Name', 'Email', 'Answer', 'Note', 'Guest']);
  assert.deepEqual(row(2), ['Ann Owner', 'ann@acme.com', 'Organizer', '', 'Colleague']);
  assert.deepEqual(row(3), ['Ben Bell', 'ben@acme.com', 'Going', 'Bringing snacks', 'Colleague']);
  assert.deepEqual(row(4), ['Cy Cole', 'cy@acme.com', 'Not answered', '', 'Colleague']);
  assert.deepEqual([sh.formats.A1, sh.frozen], [{ b: true }, { rows: 1, cols: 0 }]);
  assert.equal((await ben('POST', `/api/events/${ev.id}/guests-sheet`, {})).status, 404, 'only the organizer');
});
