// Download your data, then bring that .zip back in (another account, another server): events, contacts,
// task lists and notes come back with what they had; so do mail labels, filters that label mail, and the
// vacation reply.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-takeoutrt-'));
process.env.DATA_DIR = dir;
let server, base, port;
before(async () => {
  const { createApp } = await import('../src/app.js');
  const { attachHub } = await import('../src/hub.js');
  server = http.createServer(createApp());
  attachHub(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  call.cookie = () => cookie;
  return call;
}
const olivia = client(), kim = client();
test('the whole round trip', async () => {
  assert.equal((await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  await olivia('POST', '/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  assert.equal((await kim('POST', '/api/auth/login', { username: 'kim@acme.com', password: 'password123' })).status, 200);
  const start = Date.UTC(2026, 11, 2, 2, 0);
  await olivia('POST', '/api/events', { title: 'Board review', location: 'Room 4', start, end: start + 3600e3, tz: 'Asia/Kuala_Lumpur', rrule: { freq: 'monthly', nths: [1, 3], wd: 3 }, color: '#d50000', show_as: 'free', private: true });
  await olivia('POST', '/api/contacts', { name: 'Grace Hopper', email: 'grace@navy.example', custom_fields: [{ label: 'Badge', value: 'B-42' }], dates: [{ label: 'Anniversary', date: '1930-06-15' }] });
  const list = (await olivia('POST', '/api/tasks/lists', { name: 'Routines' })).body;
  const t = (await olivia('POST', `/api/tasks/lists/${list.id}/tasks`, { title: 'Team report', due: '2026-12-07' })).body;
  await olivia('PATCH', `/api/tasks/tasks/${t.id}`, { repeat: 'monthweek:1,3:1', repeat_until: '2027-06-30', priority: 'high' });
  const n = (await olivia('POST', '/api/notes', { title: 'Shopping', items: [{ text: 'Milk', done: true }], color: '#fff8b8', pinned: true, labels: ['home'] })).body;
  await olivia('PATCH', `/api/notes/${n.id}`, { remind_at: Date.now() + 5 * 864e5, remind_repeat: 'weekly' });

  const zip = Buffer.from(await (await fetch(`${base}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).arrayBuffer());
  const r = await fetch(`${base}/api/takeout/restore`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: kim.cookie(), 'content-type': 'application/zip' }, body: zip });
  assert.ok(r.status < 300, await r.text());

  const ev = async (c) => (await c('GET', `/api/events?from=${start - 864e5}&to=${start + 90 * 864e5}`)).body.find((e) => e.title === 'Board review');
  const pickEv = (e) => [e.location, e.tz, JSON.stringify(e.rrule), e.show_as, !!e.private, e.color];
  assert.deepEqual(pickEv(await ev(kim)), pickEv(await ev(olivia)), 'the event');
  const ct = async (c) => (await c('GET', '/api/contacts')).body.find((x) => x.name === 'Grace Hopper');
  const pickCt = (x) => [x.email, JSON.stringify(x.custom_fields), JSON.stringify(x.dates)];
  assert.deepEqual(pickCt(await ct(kim)), pickCt(await ct(olivia)), 'the contact');
  const task = async (c) => { const ls = (await c('GET', '/api/tasks/lists')).body; const l = (ls.lists || ls).find((x) => x.name.startsWith('Routines')); const ts = (await c('GET', `/api/tasks/lists/${l.id}/tasks`)).body; return (ts.tasks || ts)[0]; };
  const pickT = (x) => [x.title, x.due, x.repeat, x.repeat_until, x.priority];
  assert.deepEqual(pickT(await task(kim)), pickT(await task(olivia)), 'the task');
  const note = async (c) => { const all = (await c('GET', '/api/notes')).body; return (all.notes || all).find((x) => x.title === 'Shopping'); };
  const pickN = (x) => [JSON.stringify(x.items.map((i) => [i.text, i.done])), JSON.stringify(x.labels), x.color, !!x.pinned, x.remind_at, x.remind_repeat];
  assert.deepEqual(pickN(await note(kim)), pickN(await note(olivia)), 'the note');
});

test('mail labels, a filter that labels mail, and the vacation reply come back too', async () => {
  const { q } = await import('../src/db.js');
  const me = (await olivia('GET', '/api/auth/me')).body.user;
  const kimId = (await kim('GET', '/api/auth/me')).body.user.id;
  q('INSERT INTO mail_labels (id, user_id, name, color, keyword, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('lab-clients-1', me.id, 'Clients', '#188038', 'nwl_labclients1', Date.now());
  const rule = { id: 'r1', name: 'Client mail', enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: '@client.example' }], actions: { label: 'lab-clients-1' } };
  q('INSERT INTO mail_rules (user_id, rules, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET rules = excluded.rules').run(me.id, JSON.stringify([rule]), Date.now());
  q(`INSERT INTO vacations (user_id, enabled, subject, body, start_date, end_date, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET enabled = 1, subject = excluded.subject, body = excluded.body, start_date = excluded.start_date, end_date = excluded.end_date`)
    .run(me.id, 'Away until Monday', 'I’m away; back on Monday.\nUrgent: ring the office.', '2030-01-01', '2030-01-10', Date.now());
  const zip = Buffer.from(await (await fetch(`${base}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).arrayBuffer());
  const r = await fetch(`${base}/api/takeout/restore`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: kim.cookie(), 'content-type': 'application/zip' }, body: zip });
  assert.ok(r.status < 300, await r.text());
  const label = q('SELECT id, name, color FROM mail_labels WHERE user_id = ? AND name = ?').get(kimId, 'Clients');
  assert.deepEqual([label?.name, label?.color], ['Clients', '#188038']);
  const kimRules = JSON.parse(q('SELECT rules FROM mail_rules WHERE user_id = ?').get(kimId)?.rules || '[]');
  const theirs = kimRules.find((x) => x.name === 'Client mail');
  assert.equal(theirs?.actions?.label, label.id, 'the filter labels mail with Kim’s own Clients label');
  const v = q('SELECT enabled, subject, body, start_date, end_date FROM vacations WHERE user_id = ?').get(kimId);
  assert.deepEqual({ ...v }, { enabled: 1, subject: 'Away until Monday', body: 'I’m away; back on Monday.\nUrgent: ring the office.', start_date: '2030-01-01', end_date: '2030-01-10' });
});

test('contact groups come back, with who is in each; a name already used isn’t doubled', async () => {
  const members = [{ name: 'Ann Lee', email: 'ann@x.example' }, { name: 'Bo Chan', email: 'bo@y.example' }];
  assert.ok((await olivia('POST', '/api/contacts/groups', { name: 'Suppliers', members })).status < 300);
  const zip = Buffer.from(await (await fetch(`${base}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).arrayBuffer());
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${base}/api/takeout/restore`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: kim.cookie(), 'content-type': 'application/zip' }, body: zip });
    assert.ok(r.status < 300, await r.text());
  }
  const groups = (await kim('GET', '/api/contacts/groups')).body.filter((g) => g.name === 'Suppliers');
  assert.equal(groups.length, 1, 'once, even brought in twice');
  assert.deepEqual(groups[0].members.map((m) => [m.name, m.email]), members.map((m) => [m.name, m.email]));
});

test('booking pages come back with their settings and a new link; a co-host here is kept, one not here is left out', async () => {
  await olivia('POST', '/api/users', { local: 'sam', domain: 'acme.com', name: 'Sam Hall', password: 'password123' });
  const sam = (await import('../src/db.js')).q('SELECT id FROM users WHERE email = ?').get('sam@acme.com');
  const page = { title: 'Intro call', description: 'A quick hello', duration: 45, days: [2, 4], from_min: 600, to_min: 900, tz: 'Europe/London', notice_hours: 24, days_ahead: 14,
    buffer_min: 15, max_per_day: 3, remind: false, questions: [{ label: 'Company?', required: true }], where_kind: 'place', where_text: 'Our office', seats: 2, enabled: false, hosts: [sam.id] };
  const made = await olivia('POST', '/api/bookings', page);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const zip = Buffer.from(await (await fetch(`${base}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).arrayBuffer());
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${base}/api/takeout/restore`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: kim.cookie(), 'content-type': 'application/zip' }, body: zip });
    assert.ok(r.status < 300, await r.text());
  }
  const list = (x) => x.pages || x;
  const theirs = list((await kim('GET', '/api/bookings')).body).filter((p) => p.title === 'Intro call');
  assert.equal(theirs.length, 1, 'once, even brought in twice');
  const pick = (p) => [p.description, p.duration, JSON.stringify(p.days), p.from_min, p.to_min, p.tz, p.notice_hours, p.days_ahead, p.buffer_min, p.max_per_day, !!p.remind, JSON.stringify(p.questions), p.where_kind, p.where_text, p.seats, !!p.enabled];
  assert.deepEqual(pick(theirs[0]), pick(made.body));
  assert.deepEqual(theirs[0].hosts, [sam.id], 'Sam, a colleague here too, is still a co-host');
  assert.notEqual(theirs[0].url, made.body.url, 'a new link');
  // Into an account in another company: Sam isn't there, so the page comes without a co-host.
  const { importBookingPages } = await import('../src/routes/booking.js');
  const { q } = await import('../src/db.js');
  const kimRow = q('SELECT * FROM users WHERE email = ?').get('kim@acme.com');
  q('DELETE FROM booking_pages WHERE user_id = ?').run(kimRow.id);
  const raw = JSON.parse((await import('../src/routes/booking.js')).bookingPagesJson(q('SELECT id FROM users WHERE email = ?').get('olivia@acme.com').id));
  assert.deepEqual(raw[0].cohosts, ['sam@acme.com']);
  assert.deepEqual(importBookingPages({ ...kimRow, org_id: 'elsewhere' }, raw), { added: 1, skipped: 0 });
  assert.deepEqual(JSON.parse(q('SELECT hosts FROM booking_pages WHERE user_id = ?').get(kimRow.id).hosts), []);
});

test('calendar subscriptions and saved mail searches come back; brought in twice, still once', async () => {
  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Holidays\r\nBEGIN:VEVENT\r\nUID:h1\r\nDTSTART;VALUE=DATE:20261225\r\nDTEND;VALUE=DATE:20261226\r\nSUMMARY:Christmas Day\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/calendar' }); res.end(ics); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.CALENDAR_FEEDS_ALLOW_PRIVATE = '1';
  try {
    const url = `http://127.0.0.1:${srv.address().port}/holidays.ics`;
    const made = await olivia('POST', '/api/events/feeds', { url, name: 'Public holidays', color: '#0b8043' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const { q } = await import('../src/db.js');
    const oliviaId = (await olivia('GET', '/api/auth/me')).body.user.id;
    q('INSERT INTO mail_searches (id, user_id, name, folder, query, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('s1', oliviaId, 'Invoices', 'INBOX', 'from:billing has:attachment', 1, Date.now());
    const zip = Buffer.from(await (await fetch(`${base}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).arrayBuffer());
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${base}/api/takeout/restore`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: kim.cookie(), 'content-type': 'application/zip' }, body: zip });
      assert.ok(r.status < 300, await r.text());
    }
    let feeds;
    for (let k = 0; k < 40; k++) { feeds = (await kim('GET', '/api/events/feeds')).body; if (feeds[0]?.events) break; await new Promise((r) => setTimeout(r, 100)); }
    assert.deepEqual(feeds.map((f) => [f.name, f.url, f.color, f.events]), [['Public holidays', url, '#0b8043', 1]], 'once, fetched again from its address');
    const kimId = (await kim('GET', '/api/auth/me')).body.user.id;
    assert.deepEqual(q('SELECT name, folder, query FROM mail_searches WHERE user_id = ?').all(kimId).map((x) => ({ ...x })), [{ name: 'Invoices', folder: 'INBOX', query: 'from:billing has:attachment' }]);
  } finally { delete process.env.CALENDAR_FEEDS_ALLOW_PRIVATE; srv.close(); }
});

test('your other calendars come back as calendars of their own, with their events in them', async () => {
  const fam = (await olivia('POST', '/api/events/calendars', { name: 'Family; home', color: '#8e24aa' })).body;
  const side = (await olivia('POST', '/api/events/calendars', { name: 'Side project', color: '#f4511e' })).body;
  await olivia('PATCH', `/api/events/calendars/${side.id}`, { hidden: true });
  const start = Date.UTC(2026, 11, 20, 9);
  for (const [title, cal] of [['Grandma visit', fam.id], ['Ship the beta', side.id], ['Main thing', null]]) {
    const r = await olivia('POST', '/api/events', { title, start, end: start + 3600e3, calendar_id: cal });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const zip = Buffer.from(await (await fetch(`${base}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).arrayBuffer());
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${base}/api/takeout/restore`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: kim.cookie(), 'content-type': 'application/zip' }, body: zip });
    assert.ok(r.status < 300, await r.text());
  }
  const cals = (await kim('GET', '/api/events/calendars')).body.filter((c) => !c.shared);
  assert.deepEqual(cals.map((c) => [c.name, c.color, c.hidden]), [['Family; home', '#8e24aa', false], ['Side project', '#f4511e', true]], 'once each, with colour and hidden');
  const evs = (await kim('GET', `/api/events?from=${start - 864e5}&to=${start + 864e5}`)).body;
  const where = (t) => evs.filter((e) => e.title === t).map((e) => e.calendar_id ?? null);
  assert.deepEqual(where('Grandma visit'), [cals[0].id]);
  assert.deepEqual(where('Main thing'), [null]);
  const { q } = await import('../src/db.js');
  const kimId = (await kim('GET', '/api/auth/me')).body.user.id;
  assert.deepEqual(q("SELECT calendar_id FROM events WHERE owner_id = ? AND title = 'Ship the beta'").all(kimId).map((r) => r.calendar_id), [cals[1].id], 'in the hidden one too');
});

test('your own settings come back, each only where it’s still the default', async () => {
  const hours = { days: [1, 2, 3, 4], start: 8 * 60, end: 16 * 60, tz: 'Europe/Berlin' };
  assert.equal((await olivia('PUT', '/api/users/me/work-hours', { hours })).status, 200);
  assert.equal((await olivia('PUT', '/api/users/me/world-clocks', { zones: ['Asia/Tokyo', 'America/New_York'] })).status, 200);
  assert.equal((await olivia('PUT', '/api/users/me/file-format', { format: 'odf' })).status, 200);
  assert.equal((await olivia('PUT', '/api/notes/view', { view: 'list', sort: 'title' })).status, 200);
  assert.ok((await olivia('PUT', '/api/notes/label-colors', { label: 'home', color: '#188038' })).status < 300);
  // Kim has already picked their own world clocks: those stay.
  assert.equal((await kim('PUT', '/api/users/me/world-clocks', { zones: ['Australia/Sydney'] })).status, 200);
  const zip = Buffer.from(await (await fetch(`${base}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).arrayBuffer());
  const JSZip = (await import('jszip')).default;
  const settings = JSON.parse(await (await JSZip.loadAsync(zip)).file('Settings.json').async('string'));
  for (const k of Object.keys(settings.settings)) assert.ok(!/hash|password|admin|quota|email|username|org/.test(k), `${k} isn’t a setting`);
  const r = await fetch(`${base}/api/takeout/restore`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: kim.cookie(), 'content-type': 'application/zip' }, body: zip });
  assert.ok(r.status < 300);
  const out = await r.json();
  assert.ok(out.settings?.added >= 4, JSON.stringify(out.settings));
  const h = (await kim('GET', '/api/users/me/work-hours')).body;
  assert.deepEqual([h.days, h.start, h.end, h.tz], [hours.days, hours.start, hours.end, hours.tz]);
  const { q } = await import('../src/db.js');
  const kimRow = q('SELECT world_clocks, file_format FROM users WHERE username = ?').get('kim@acme.com');
  assert.deepEqual([JSON.parse(kimRow.world_clocks), kimRow.file_format], [['Australia/Sydney'], 'odf']);
  assert.deepEqual((await kim('GET', '/api/notes/view')).body, { view: 'list', sort: 'title' });
  assert.equal((await kim('GET', '/api/notes/label-colors')).body.home, '#188038');
  // Something that isn't right (made-up hours) is left out, not saved.
  const { importPrefs } = await import('../src/prefsexport.js');
  const samId = q('SELECT id FROM users WHERE username = ?').get('sam@acme.com').id;
  assert.deepEqual(importPrefs(samId, { settings: { work_hours: '{"days":[],"start":0,"end":0}', file_format: 'pdf', password_hash: 'x', is_admin: 1 } }), { added: 0 });
});

test('Drive’s stars, folder colours, descriptions and labels come back on the files brought in', async () => {
  const folder = (await olivia('POST', '/api/files/folder', { name: 'Contracts' })).body;
  assert.equal((await olivia('PATCH', `/api/files/${folder.id}`, { color: '#d93025', description: 'Signed ones only' })).status, 200);
  await olivia('PUT', `/api/files/${folder.id}/star`, { starred: true });
  const up = await fetch(`${base}/api/files/upload?name=${encodeURIComponent('lease.txt')}&parent=${folder.id}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie(), 'content-type': 'text/plain' }, body: 'the lease' });
  const file = await up.json();
  assert.ok(up.status < 300, JSON.stringify(file));
  const fileId = file.id || file.files?.[0]?.id;
  assert.equal((await olivia('PUT', `/api/files/${fileId}/labels`, { labels: ['Legal', 'Urgent'] })).status, 200);
  assert.equal((await olivia('PATCH', `/api/files/${fileId}`, { description: 'Office lease, 2026' })).status, 200);
  const zip = Buffer.from(await (await fetch(`${base}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).arrayBuffer());
  const r = await fetch(`${base}/api/takeout/restore`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: kim.cookie(), 'content-type': 'application/zip' }, body: zip });
  assert.ok(r.status < 300);
  const out = await r.json();
  const { q } = await import('../src/db.js');
  const kimId = (await kim('GET', '/api/auth/me')).body.user.id;
  const root = q('SELECT id FROM files WHERE id = ?').get(out.drive.folder_id);
  const f2 = q("SELECT * FROM files WHERE owner_id = ? AND name = 'Contracts' AND parent_id = ?").get(kimId, root.id);
  assert.deepEqual([f2.color, f2.description], ['#d93025', 'Signed ones only']);
  assert.ok(q('SELECT 1 FROM file_stars WHERE user_id = ? AND file_id = ?').get(kimId, f2.id), 'starred');
  const l2 = q("SELECT * FROM files WHERE owner_id = ? AND name = 'lease.txt' AND parent_id = ?").get(kimId, f2.id);
  assert.equal(l2.description, 'Office lease, 2026');
  assert.deepEqual(q('SELECT label FROM file_labels WHERE user_id = ? AND file_id = ? ORDER BY label').all(kimId, l2.id).map((x) => x.label), ['Legal', 'Urgent']);
  assert.ok(out.drive_details.files >= 2);
});

test('documents, spreadsheets and presentations come back as them, with their words; a real Word file stays a Word file', async () => {
  const doc = (await olivia('POST', '/api/files/new', { kind: 'doc', name: 'Handbook', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Welcome aboard' }] }] } })).body;
  await olivia('PUT', `/api/files/${doc.id}/star`, { starred: true });
  await olivia('POST', '/api/files/new', { kind: 'sheet', name: 'Budget', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Rent', B1: '1200' } }] } });
  const { wordFromDoc } = await import('../src/office/word.js');
  const word = await wordFromDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From outside' }] }] }, 'Supplier');
  const up = await fetch(`${base}/api/files/upload?name=Supplier.docx`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie(), 'content-type': 'application/octet-stream' }, body: word });
  assert.ok(up.status < 300);
  const zip = Buffer.from(await (await fetch(`${base}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).arrayBuffer());
  const r = await fetch(`${base}/api/takeout/restore`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: kim.cookie(), 'content-type': 'application/zip' }, body: zip });
  const out = await r.json();
  assert.ok(out.documents?.converted >= 2, JSON.stringify(out.documents));
  const { q } = await import('../src/db.js');
  const kimId = (await kim('GET', '/api/auth/me')).body.user.id;
  const root = out.drive.folder_id;
  const here = q('SELECT id, name, kind, content FROM files WHERE parent_id = ? AND trashed = 0').all(root);
  const hb = here.find((f) => f.name === 'Handbook');
  assert.equal(hb?.kind, 'doc');
  assert.match(hb.content, /Welcome aboard/);
  assert.ok(q('SELECT 1 FROM file_stars WHERE user_id = ? AND file_id = ?').get(kimId, hb.id), 'its star is on the document');
  const bd = here.find((f) => f.name === 'Budget');
  assert.equal(bd?.kind, 'sheet');
  assert.match(bd.content, /Rent/);
  assert.ok(here.some((f) => f.name === 'Supplier.docx' && f.kind === 'file'), 'an uploaded Word file stays one');
  assert.ok(!here.some((f) => f.name === 'Handbook.docx'), 'the downloaded Word file isn’t left beside it');
});

test('a document’s comments and page setup come back with it', async () => {
  const doc = (await olivia('POST', '/api/files/new', { kind: 'doc', name: 'Proposal', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The budget is ten thousand' }] }] } })).body;
  const c = await olivia('POST', `/api/comments/${doc.id}`, { body: 'Is this enough?', anchor: { quote: 'ten thousand' } });
  assert.ok(c.status < 300, JSON.stringify(c.body));
  // The comment's words are marked in the document (as the editor does when you comment on them).
  const { q: qq } = await import('../src/db.js');
  const tid = c.body.id || c.body.comment?.id;
  qq('UPDATE files SET content = ? WHERE id = ?').run(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The budget is ' }, { type: 'text', text: 'ten thousand', marks: [{ type: 'comment', attrs: { id: tid } }] }] }] }), doc.id);
  const p = await olivia('PATCH', `/api/files/${doc.id}`, { page_setup: { size: 'a4', orientation: 'landscape' } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const zip = Buffer.from(await (await fetch(`${base}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace', cookie: olivia.cookie() } })).arrayBuffer());
  const r = await fetch(`${base}/api/takeout/restore`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', cookie: kim.cookie(), 'content-type': 'application/zip' }, body: zip });
  const out = await r.json();
  const { q } = await import('../src/db.js');
  const back = q("SELECT * FROM files WHERE parent_id = ? AND name = 'Proposal' AND trashed = 0").get(out.drive.folder_id);
  assert.equal(back?.kind, 'doc');
  const comments = q('SELECT body, anchor FROM file_comments WHERE file_id = ?').all(back.id);
  assert.equal(comments.length, 1, JSON.stringify(comments));
  assert.match(comments[0].body, /^Is this enough\?/);
  assert.match(comments[0].body, /Olivia Owner/, 'says who wrote it');
  assert.match(comments[0].anchor, /ten thousand/);
  const setup = JSON.parse(back.page_setup || '{}');
  assert.deepEqual([setup.size, setup.orientation], ['a4', 'landscape']);
});
