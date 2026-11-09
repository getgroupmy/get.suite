import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-timeoff-'));
const { createApp } = await import('../src/app.js');
const { workdays } = await import('../src/routes/timeoff.js');

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

test('working days: weekends left out', () => {
  assert.equal(workdays('2026-11-09', '2026-11-13'), 5);
  assert.equal(workdays('2026-11-13', '2026-11-16'), 2, 'Friday to Monday');
  assert.equal(workdays('2026-11-14', '2026-11-15'), 0);
});

test('time off: asked, decided by the manager (or an admin), an out-of-office day on approval, cancelled', async () => {
  const boss = client(), tom = client(), mia = client(), zed = client();
  await boss('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Bea Boss', local: 'bea', password: 'password123' });
  const id = {};
  for (const [c, local, name] of [[tom, 'tom', 'Tom Team'], [mia, 'mia', 'Mia Manager'], [zed, 'zed', 'Zed Other']]) {
    id[local] = (await boss('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).body.id;
    assert.equal((await c('POST', '/api/auth/login', { username: `${local}@acme.com`, password: 'password123' })).status, 200);
  }
  assert.equal((await boss('PATCH', `/api/users/${id.tom}`, { manager_id: id.mia })).status, 200);

  // Checks.
  assert.equal((await tom('POST', '/api/time-off', { start_date: '2026-12-24', end_date: '2026-12-21' })).status, 400);
  assert.equal((await tom('POST', '/api/time-off', { start_date: '2026-02-30' })).status, 400);
  assert.equal((await tom('POST', '/api/time-off', { start_date: '2026-12-21', kind: 'party' })).status, 400);
  assert.equal((await tom('POST', '/api/time-off', { start_date: '2026-12-19' })).status, 400, 'a Saturday on its own');

  const asked = await tom('POST', '/api/time-off', { start_date: '2026-12-21', end_date: '2026-12-24', kind: 'vacation', note: 'Family visit', tz: 'Europe/Berlin' });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  assert.equal(asked.body.status, 'pending');
  assert.equal(asked.body.days, 4);
  assert.equal((await tom('POST', '/api/time-off', { start_date: '2026-12-23', end_date: '2026-12-28' })).status, 400, 'overlaps');
  // Mia (his manager) is told and decides; the admin and others can't.
  const note = (await mia('GET', '/api/notifications')).body.items.find((n) => n.kind === 'timeoff');
  assert.equal(note.title, 'Tom Team asks for time off');
  assert.match(note.body, /Vacation: Mon 21 Dec – Thu 24 Dec \(4 working days\) · Family visit/);
  assert.deepEqual((await mia('GET', '/api/time-off')).body.to_decide.map((r) => r.name), ['Tom Team']);
  assert.deepEqual((await boss('GET', '/api/time-off')).body.to_decide, [], 'he has a manager: not the admin');
  assert.equal((await zed('POST', `/api/time-off/${asked.body.id}/decide`, { approve: true })).status, 403);
  assert.equal((await boss('POST', `/api/time-off/${asked.body.id}/decide`, { approve: true })).status, 403);
  const ok = await mia('POST', `/api/time-off/${asked.body.id}/decide`, { approve: true, answer: 'Enjoy!' });
  assert.equal(ok.body.status, 'approved');
  assert.equal(ok.body.decided_by_name, 'Mia Manager');
  assert.equal((await mia('POST', `/api/time-off/${asked.body.id}/decide`, { approve: false })).status, 400, 'decided already');
  const told = (await tom('GET', '/api/notifications')).body.items.find((n) => n.kind === 'timeoff');
  assert.equal(told.title, 'Mia Manager approved your time off');
  assert.match(told.body, /Enjoy!/);
  // An all-day out-of-office event, midnight to midnight in Berlin.
  const evs = (await tom('GET', `/api/events?from=${Date.UTC(2026, 11, 1)}&to=${Date.UTC(2027, 0, 1)}`)).body;
  const ev = evs.find((e) => e.id === ok.body.event_id);
  assert.equal(ev.kind, 'ooo');
  assert.equal(ev.title, 'Vacation');
  assert.equal(ev.all_day, 1);
  assert.equal(ev.start, Date.UTC(2026, 11, 20, 23));
  assert.equal(ev.end, Date.UTC(2026, 11, 24, 23) - 1);
  // Invitations for those days are declined for him, as with any time off.
  const inv = await zed('POST', '/api/events', { title: 'Year-end review', start: Date.UTC(2026, 11, 22, 10), end: Date.UTC(2026, 11, 22, 11), guests: ['tom@acme.com'] });
  assert.equal(inv.status, 201);
  assert.equal(inv.body.guests.find((g) => g.email === 'tom@acme.com').status, 'no');

  // Mia has no manager: her request goes to the admin. Declined.
  const hers = (await mia('POST', '/api/time-off', { start_date: '2027-01-04', kind: 'personal' })).body;
  assert.deepEqual((await boss('GET', '/api/time-off')).body.to_decide.map((r) => r.id), [hers.id]);
  const no = await boss('POST', `/api/time-off/${hers.id}/decide`, { approve: false, answer: 'Stocktake that day' });
  assert.equal(no.body.status, 'declined');
  assert.equal(no.body.event_id, null);

  // Tom cancels his approved time off: the event goes, Mia is told.
  const gone = await tom('DELETE', `/api/time-off/${asked.body.id}`);
  assert.equal(gone.body.status, 'cancelled');
  assert.ok(!(await tom('GET', `/api/events?from=${Date.UTC(2026, 11, 1)}&to=${Date.UTC(2027, 0, 1)}`)).body.some((e) => e.id === ok.body.event_id), 'the event went');
  assert.equal((await mia('GET', '/api/notifications')).body.items[0].title, 'Tom Team cancelled time off');
  assert.equal((await zed('DELETE', `/api/time-off/${hers.id}`)).status, 404, 'only your own');
  // The admin with nobody else to ask: approved at once.
  const solo = (await boss('POST', '/api/time-off', { start_date: '2027-02-01' })).body;
  assert.equal(solo.status, 'approved', 'the only admin, reporting to nobody');
  assert.ok(solo.event_id);
});
