// Tasks → Copy to a document: the list as a checklist (sections as headings, due dates, who, steps), done ones on request.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-tasksdoc-'));
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

test('a list as a document: open tasks as a checklist by section with due date, who and steps; done ones when asked', async () => {
  const olivia = client(), mia = client();
  assert.equal((await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  assert.equal((await olivia('POST', '/api/users', { local: 'mia', domain: 'acme.com', name: 'Mia Member', password: 'password123' })).status, 201);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const list = (await olivia('POST', '/api/tasks/lists', { name: 'Launch' })).body.id;
  const week = (await olivia('POST', `/api/tasks/lists/${list}/sections`, { name: 'This week' })).body.id;
  const post = (await olivia('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Write the post', due: '2026-12-03', important: true, section_id: week })).body;
  const drafted = (await olivia('POST', `/api/tasks/tasks/${post.id}/steps`, { title: 'Draft' })).body.steps[0];
  await olivia('PATCH', `/api/tasks/tasks/${post.id}/steps/${drafted.id}`, { done: true });
  await olivia('POST', `/api/tasks/tasks/${post.id}/steps`, { title: 'Review' });
  await olivia('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Pick a date' });
  const old = (await olivia('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Book the room' })).body;
  await olivia('PATCH', `/api/tasks/tasks/${old.id}`, { done: true });

  const r = await olivia('POST', `/api/tasks/lists/${list}/doc`, { tz: 'UTC' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.name, 'Launch (tasks)');
  const doc = (await olivia('GET', `/api/files/${r.body.id}/content`)).body.content;
  const text = (n) => (n.text || '') + (n.content || []).map(text).join('');
  const shown = doc.content.map((n) => (n.type === 'taskList' ? `list:${n.content.map((i) => `${i.attrs.checked ? '[x]' : '[ ]'} ${text(i.content[0])}${i.content[1] ? ` {${i.content[1].content.map((x) => `${x.attrs.checked ? 'x' : '-'}${text(x)}`).join(',')}}` : ''}`).join(' | ')}` : `${n.type}:${text(n)}`));
  assert.equal(shown[0], 'heading:Launch');
  assert.match(shown[1], /^paragraph:\d+ \w+ \d{4} · 2 open, 1 done$/);
  assert.deepEqual(shown.slice(2), ['list:[ ] Pick a date', 'heading:This week', 'list:[ ] Write the post — due 3 Dec 2026 · ★ {xDraft,-Review}']);
  // With the done ones; someone who can't see the list can't.
  const all = (await olivia('GET', `/api/files/${(await olivia('POST', `/api/tasks/lists/${list}/doc`, { done: true })).body.id}/content`)).body.content;
  assert.equal(text(all.content.at(-2)), 'Done');
  assert.equal(all.content.at(-1).content[0].attrs.checked, true);
  assert.equal(text(all.content.at(-1)), 'Book the room');
  assert.equal((await mia('POST', `/api/tasks/lists/${list}/doc`, {})).status, 404);
});

test('a sheet’s rows added to a list (from-sheet): read as Import from CSV reads them; a sheet not laid out so is explained', async () => {
  const ann = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  const list = (await ann('POST', '/api/tasks/lists', { name: 'From the sheet' })).body.id;
  const sh = (await ann('POST', '/api/files/new', { kind: 'sheet', name: 'Jobs', content: { sheets: [{ name: 'S', cells: { A1: 'Title', B1: 'Due', C1: 'Notes', A2: 'Order chairs', B2: '2026-12-03', C2: 'Ten of them', A3: 'Book van', B3: '', C3: '' } }] } })).body;
  const r = await ann('POST', `/api/tasks/lists/${list}/from-sheet`, { file: sh.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.added, r.body.list.name], [2, 'From the sheet']);
  const tasks = (await ann('GET', `/api/tasks/lists/${list}/tasks`)).body;
  const chairs = tasks.find((t) => t.title === 'Order chairs');
  assert.deepEqual([chairs.due, chairs.notes], ['2026-12-03', 'Ten of them']);
  assert.ok(tasks.some((t) => t.title === 'Book van'));
  const notTasks = (await ann('POST', '/api/files/new', { kind: 'sheet', name: 'Numbers', content: { sheets: [{ name: 'S', cells: { A1: 'x', B1: 'y', A2: '1', B2: '2' } }] } })).body;
  assert.equal((await ann('POST', `/api/tasks/lists/${list}/from-sheet`, { file: notTasks.id })).status, 400);
  const d = (await ann('POST', '/api/files/new', { kind: 'doc', name: 'D' })).body;
  assert.equal((await ann('POST', `/api/tasks/lists/${list}/from-sheet`, { file: d.id })).status, 400);
  assert.equal((await ann('POST', `/api/tasks/lists/${list}/from-sheet`, { file: 'nope' })).status, 404);
});

test('a sheet’s rows added to Contacts (from-sheet): read as Import reads a CSV, no one added twice, a sheet not so laid out explained', async () => {
  const ann = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  const sh = (await ann('POST', '/api/files/new', { kind: 'sheet', name: 'Suppliers', content: { sheets: [{ name: 'S', cells: {
    A1: 'Name', B1: 'Email', C1: 'Phone', D1: 'Company', A2: 'Rhea Rowe', B2: 'rhea@supply.example', C2: "'+44 20 7946 0000", D2: 'Rowe Paper', A3: 'Sol Sand', B3: 'sol@supply.example' } }] } })).body;
  const r = await ann('POST', '/api/contacts/from-sheet', { file: sh.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.added, r.body.skipped], [2, 0]);
  const rhea = (await ann('GET', '/api/contacts')).body.find((c) => c.email === 'rhea@supply.example');
  assert.deepEqual([rhea.name, rhea.phone, rhea.company], ['Rhea Rowe', '+44 20 7946 0000', 'Rowe Paper']);
  assert.deepEqual((await ann('POST', '/api/contacts/from-sheet', { file: sh.id })).body, { added: 0, skipped: 2 });
  const nums = (await ann('POST', '/api/files/new', { kind: 'sheet', name: 'Numbers', content: { sheets: [{ name: 'S', cells: { A1: 'x', B1: 'y', A2: '1', B2: '2' } }] } })).body;
  const no = await ann('POST', '/api/contacts/from-sheet', { file: nums.id });
  assert.equal(no.status, 400);
  assert.match(no.body.error, /laid out as contacts/);
  assert.equal((await ann('POST', '/api/contacts/from-sheet', { file: 'nope' })).status, 404);
});

test('everyone on an email added to Contacts (add-people): not you, not colleagues, not anyone already there', async () => {
  const ann = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  await ann('POST', '/api/contacts', { name: 'Kit Known', email: 'kit@known.example' });
  const r = await ann('POST', '/api/contacts/add-people', { people: [
    { name: 'Pia Port', email: 'pia@port.example' }, { name: '', email: 'Quin@Port.example' }, { name: 'Kit K', email: 'KIT@known.example' },
    { name: 'Mia Member', email: 'mia@acme.com' }, { name: 'Me', email: 'olivia@acme.com' }, { name: 'Bad', email: 'not an address' }, { name: 'Pia again', email: 'pia@port.example' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.added, r.body.skipped, r.body.names], [2, 4, ['Pia Port', 'quin']]);
  const mine = (await ann('GET', '/api/contacts')).body;
  assert.ok(mine.some((c) => c.email === 'quin@port.example' && c.name === 'quin'));
  assert.ok(!mine.some((c) => c.email === 'mia@acme.com'));
  assert.equal(mine.filter((c) => c.email === 'kit@known.example').length, 1);
  assert.equal((await ann('POST', '/api/contacts/add-people', { people: [] })).status, 400);
});

test('a contact group in Sheets: each member with the phone and company of the contact they are; only your own groups', async () => {
  const ann = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  await ann('POST', '/api/contacts', { name: 'Vera Vine', email: 'vera@vine.example', phone: '+44 20 7946 0123', company: 'Vine & Co', title: 'Buyer' });
  const g = (await ann('POST', '/api/contacts/groups', { name: 'Suppliers', members: [{ name: 'Vera Vine', email: 'vera@vine.example' }, { name: '', email: 'walt@wood.example' }] })).body;
  const r = await ann('POST', `/api/contacts/groups/${g.id}/sheet`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.members], ['Suppliers (group)', 2]);
  const sh = (await ann('GET', `/api/files/${r.body.id}/content`)).body.content.sheets[0];
  assert.equal(sh.name, 'Suppliers');
  assert.deepEqual(['A1', 'B1', 'C1', 'D1', 'E1'].map((k) => sh.cells[k]), ['Name', 'Email', 'Phone', 'Company', 'Job title']);
  assert.deepEqual(['A2', 'B2', 'C2', 'D2', 'E2'].map((k) => sh.cells[k]), ['Vera Vine', 'vera@vine.example', "'+44 20 7946 0123", 'Vine & Co', 'Buyer']);
  assert.deepEqual([sh.cells.A3 || '', sh.cells.B3], ['', 'walt@wood.example']);
  const empty = (await ann('POST', '/api/contacts/groups', { name: 'Nobody yet', members: [] })).body;
  assert.equal((await ann('POST', `/api/contacts/groups/${empty.id}/sheet`, {})).status, 400);
  const mia = client();
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  assert.equal((await mia('POST', `/api/contacts/groups/${g.id}/sheet`, {})).status, 404);
});

test('a contact group from a sheet: its Name and Email rows, rows without an address left out; a sheet not so laid out explained', async () => {
  const ann = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  const sh = (await ann('POST', '/api/files/new', { kind: 'sheet', name: 'Volunteers', content: { sheets: [{ name: 'S', cells: {
    A1: 'Name', B1: 'Email', A2: 'Xan Xu', B2: 'xan@vol.example', A3: 'Yara Yu', B3: 'YARA@vol.example', A4: 'Zed (no email)', B4: '' } }] } })).body;
  const r = await ann('POST', '/api/contacts/groups/from-sheet', { file: sh.id, name: 'Volunteers' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.members.map((m) => `${m.name} <${m.email}>`), r.body.left_out], ['Volunteers', ['Xan Xu <xan@vol.example>', 'Yara Yu <yara@vol.example>'], 1]);
  assert.equal((await ann('POST', '/api/contacts/groups/from-sheet', { file: sh.id, name: 'volunteers' })).status, 400, 'a name already taken');
  const nums = (await ann('POST', '/api/files/new', { kind: 'sheet', name: 'N', content: { sheets: [{ name: 'S', cells: { A1: 'x', B1: 'y', A2: '1', B2: '2' } }] } })).body;
  const no = await ann('POST', '/api/contacts/groups/from-sheet', { file: nums.id, name: 'Numbers' });
  assert.equal(no.status, 400);
  assert.match(no.body.error, /laid out as contacts|No email addresses/);
  assert.equal((await ann('POST', '/api/contacts/groups/from-sheet', { file: sh.id, name: '' })).status, 400);
});
