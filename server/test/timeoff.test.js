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

test('vacation allowance: days a year for the company or one person, what\'s left, and the team view', async () => {
  const boss = client(), tom = client(), mia = client();
  assert.equal((await boss('POST', '/api/auth/login', { username: 'bea@acme.com', password: 'password123' })).status, 200);
  await tom('POST', '/api/auth/login', { username: 'tom@acme.com', password: 'password123' });
  await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' });
  assert.equal((await tom('PUT', '/api/time-off/allowance', { days: 30 })).status, 403, 'admins only');
  assert.equal((await boss('PUT', '/api/time-off/allowance', { days: 2.5 })).status, 400);
  assert.deepEqual((await boss('PUT', '/api/time-off/allowance', { days: 10 })).body, { days: 10 });
  // Tom: 10 days in 2027; 3 asked (pending) and 2 approved count.
  const a1 = (await tom('POST', '/api/time-off', { start_date: '2027-03-01', end_date: '2027-03-03', tz: 'UTC' })).body; // Mon–Wed
  const a2 = (await tom('POST', '/api/time-off', { start_date: '2027-04-01', end_date: '2027-04-02', tz: 'UTC' })).body; // Thu–Fri
  await mia('POST', `/api/time-off/${a2.id}/decide`, { approve: true });
  const team = (await mia('GET', '/api/time-off/team?year=2027')).body;
  assert.deepEqual(team.people.map((p) => p.name), ['Tom Team'], 'Mia sees the people she decides for');
  assert.deepEqual(team.people[0].balance, { year: 2027, days: 10, used: 2, pending: 3, left: 5 });
  assert.equal(team.can_set, false);
  // Over what's left: refused, saying how much is left. Sick leave doesn't count.
  const over = await tom('POST', '/api/time-off', { start_date: '2027-05-03', end_date: '2027-05-10', tz: 'UTC' }); // 6 working days
  assert.equal(over.status, 400);
  assert.match(over.body.error, /That's 6 vacation days in 2027; you have 5 left/);
  assert.equal((await tom('POST', '/api/time-off', { start_date: '2027-05-03', end_date: '2027-05-10', kind: 'sick', tz: 'UTC' })).status, 201);
  // A request across New Year counts each year's days in that year.
  const nye = (await tom('POST', '/api/time-off', { start_date: '2027-12-30', end_date: '2028-01-04', tz: 'UTC' })).body; // Thu, Fri | Mon, Tue
  assert.equal(nye.days, 4);
  assert.equal((await tom('GET', '/api/time-off')).body.to_decide.length, 0);
  assert.deepEqual((await mia('GET', '/api/time-off')).body.to_decide.find((r) => r.id === nye.id).balance, { year: 2027, days: 10, used: 2, pending: 5, left: 3 });
  // Cancelling gives days back; one person's own allowance wins over the company's.
  await tom('DELETE', `/api/time-off/${a1.id}`);
  assert.equal((await boss('PUT', `/api/time-off/allowance/${team.people[0].id}`, { days: 25 })).body.days, 25);
  const all = (await boss('GET', '/api/time-off/team?year=2027')).body;
  assert.equal(all.can_set, true);
  assert.equal(all.company_days, 10);
  const t = all.people.find((p) => p.name === 'Tom Team');
  assert.deepEqual([t.own_days, t.balance.left], [25, 21]);
  assert.ok(t.coming.length >= 0);
  assert.equal((await boss('PUT', `/api/time-off/allowance/${team.people[0].id}`, { days: null })).body.days, 10, 'back to the company\'s');
  assert.equal((await boss('PUT', '/api/time-off/allowance', { days: null })).body.days, null, 'no limit');
  assert.equal((await tom('GET', '/api/time-off')).body.balance.left, null);
});

test('company holidays: on everyone\'s list, not working days in time off; admins only', async () => {
  const boss = client(), tom = client();
  await boss('POST', '/api/auth/login', { username: 'bea@acme.com', password: 'password123' });
  await tom('POST', '/api/auth/login', { username: 'tom@acme.com', password: 'password123' });
  assert.equal((await tom('POST', '/api/time-off/holidays', { date: '2027-11-22', name: 'Boxing Day (moved)' })).status, 403);
  assert.equal((await boss('POST', '/api/time-off/holidays', { date: '2027-13-01', name: 'x' })).status, 400);
  assert.equal((await boss('POST', '/api/time-off/holidays', { date: '2027-11-22' })).status, 400, 'a name');
  const h = (await boss('POST', '/api/time-off/holidays', { date: '2027-11-22', name: 'Boxing Day (moved)' })).body;
  await boss('POST', '/api/time-off/holidays', { date: '2027-11-23', name: 'Company day' });
  assert.equal((await boss('POST', '/api/time-off/holidays', { date: '2027-11-22', name: 'Again' })).status, 400, 'one a day');
  assert.deepEqual((await tom('GET', '/api/time-off/holidays?from=2027-11-01&to=2027-11-26')).body.map((x) => x.name), ['Boxing Day (moved)', 'Company day']);
  // Mon 22 – Fri 26 Nov: 5 weekdays, 2 of them holidays.
  const r = (await tom('POST', '/api/time-off', { start_date: '2027-11-22', end_date: '2027-11-26', kind: 'personal', tz: 'UTC' })).body;
  assert.equal(r.days, 3);
  const only = await tom('POST', '/api/time-off', { start_date: '2027-11-23', kind: 'sick', tz: 'UTC' });
  assert.equal(only.status, 400, 'nothing but a holiday');
  assert.match(only.body.error, /company holiday/);
  assert.equal((await tom('DELETE', `/api/time-off/holidays/${h.id}`)).status, 403);
  assert.equal((await boss('DELETE', `/api/time-off/holidays/${h.id}`)).status, 200);
  assert.equal((await tom('GET', '/api/time-off')).body.mine.find((x) => x.id === r.id).days, 4, 'counted again once it is no holiday');
});

test('who\'s out: colleagues on approved time off that day, back on the next working day; the next holiday', async () => {
  const boss = client(), tom = client(), mia = client();
  await boss('POST', '/api/auth/login', { username: 'bea@acme.com', password: 'password123' });
  await tom('POST', '/api/auth/login', { username: 'tom@acme.com', password: 'password123' });
  await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' });
  // Tom: Wed 6 – Fri 8 Oct 2027, approved; Mon 11 Oct is a holiday, so he's back Tue 12.
  await boss('POST', '/api/time-off/holidays', { date: '2027-10-11', name: 'Harvest Day' });
  const before = (await mia('GET', '/api/time-off/out?date=2027-10-07')).body.waiting;
  const r = (await tom('POST', '/api/time-off', { start_date: '2027-10-06', end_date: '2027-10-08', kind: 'sick', tz: 'UTC' })).body;
  assert.equal((await mia('GET', '/api/time-off/out?date=2027-10-07')).body.waiting, before + 1, 'one more waiting for Mia');
  await mia('POST', `/api/time-off/${r.id}/decide`, { approve: true });
  const seen = (await boss('GET', '/api/time-off/out?date=2027-10-07')).body;
  assert.deepEqual(seen.out.map((x) => [x.name, x.until, x.back]), [['Tom Team', '2027-10-08', '2027-10-12']]);
  assert.equal(seen.out[0].kind, undefined, 'not what kind of time off');
  assert.deepEqual([seen.holiday.date, seen.holiday.name], ['2027-10-11', 'Harvest Day']);
  assert.deepEqual((await tom('GET', '/api/time-off/out?date=2027-10-07')).body.out, [], 'not yourself');
  assert.deepEqual((await boss('GET', '/api/time-off/out?date=2027-10-12')).body.out, [], 'back');
});
