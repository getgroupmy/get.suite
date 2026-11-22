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

test('a task list in Sheets: open tasks then done ones, in the Excel columns; Add rows to Tasks reads it back', async () => {
  const ann = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  const list = (await ann('POST', '/api/tasks/lists', { name: 'Garden' })).body.id;
  assert.equal((await ann('POST', `/api/tasks/lists/${list}/sheet`, {})).status, 400, 'nothing yet');
  await ann('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Prune roses', due: '2026-12-01' });
  const done = (await ann('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Rake leaves' })).body;
  await ann('PATCH', `/api/tasks/tasks/${done.id}`, { done: true });
  const r = await ann('POST', `/api/tasks/lists/${list}/sheet`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.tasks], ['Garden (tasks)', 2]);
  const sh = (await ann('GET', `/api/files/${r.body.id}/content`)).body.content.sheets[0];
  assert.deepEqual([sh.cells.A1, sh.cells.B1, sh.cells.C1], ['Task', 'Status', 'Due']);
  assert.deepEqual([sh.cells.A2, sh.cells.B2, sh.cells.A3, sh.cells.B3], ['Prune roses', 'To do', 'Rake leaves', 'Done']);
  const back = (await ann('POST', '/api/tasks/lists', { name: 'Garden again' })).body.id;
  const imp = await ann('POST', `/api/tasks/lists/${back}/from-sheet`, { file: r.body.id });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  const again = (await ann('GET', `/api/tasks/lists/${back}/tasks`)).body;
  assert.ok(again.some((t) => t.title === 'Prune roses' && t.due === '2026-12-01'), JSON.stringify(again));
  const mia = client();
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  assert.equal((await mia('POST', `/api/tasks/lists/${list}/sheet`, {})).status, 404);
});

test('a sheet copied to a new document: a table of what the cells show, the heading row, a range; not a document', async () => {
  const ann = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  const sh = (await ann('POST', '/api/files/new', { kind: 'sheet', name: 'Q4 costs', content: { sheets: [{ name: 'Costs', cells: { A1: 'Item', B1: 'Cost', A2: 'Rent', B2: '1200', A3: 'Power', B3: '300', A4: 'Total', B4: '=SUM(B2:B3)' } }] } })).body;
  const r = await ann('POST', `/api/files/${sh.id}/sheet-doc`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.rows, r.body.range], ['Q4 costs (table)', 4, 'A1:B4']);
  const doc = (await ann('GET', `/api/files/${r.body.id}/content`)).body.content;
  assert.equal(doc.content[0].type, 'heading');
  const table = doc.content.find((n) => n.type === 'table');
  const cells = table.content.map((row) => row.content.map((c) => `${c.type === 'tableHeader' ? '*' : ''}${(c.content[0].content || []).map((x) => x.text).join('')}`));
  assert.deepEqual(cells, [['*Item', '*Cost'], ['Rent', '1200'], ['Power', '300'], ['Total', '1500']]);
  const part = await ann('POST', `/api/files/${sh.id}/sheet-doc`, { range: 'A1:A2' });
  assert.deepEqual([part.status, part.body.rows, part.body.range], [201, 2, 'A1:A2']);
  assert.equal((await ann('POST', `/api/files/${sh.id}/sheet-doc`, { range: 'nope' })).status, 400);
  const d = (await ann('POST', '/api/files/new', { kind: 'doc', name: 'D' })).body;
  assert.equal((await ann('POST', `/api/files/${d.id}/sheet-doc`, {})).status, 400);
});

test('a sheet copied to a new presentation: a slide with its title and the table of what the cells show; too big asks for a range', async () => {
  const ann = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  const sh = (await ann('POST', '/api/files/new', { kind: 'sheet', name: 'Sales', content: { sheets: [{ name: 'S', cells: { A1: 'Region', B1: 'Q1', A2: 'North', B2: '40', A3: 'South', B3: '=B2*2' } }] } })).body;
  const r = await ann('POST', `/api/files/${sh.id}/sheet-slides`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.rows], ['Sales (slides)', 3]);
  const deck = (await ann('GET', `/api/files/${r.body.id}/content`)).body.content;
  const items = deck.slides[0].items;
  assert.equal(items.find((x) => x.role === 'title').text, 'Sales');
  const table = items.find((x) => x.type === 'table');
  assert.deepEqual([table.header, table.cells], [true, [['Region', 'Q1'], ['North', '40'], ['South', '80']]]);
  const big = {}; for (let i = 1; i <= 25; i++) big[`A${i}`] = String(i);
  const bs = (await ann('POST', '/api/files/new', { kind: 'sheet', name: 'Long', content: { sheets: [{ name: 'S', cells: big }] } })).body;
  const no = await ann('POST', `/api/files/${bs.id}/sheet-slides`, {});
  assert.equal(no.status, 400);
  assert.match(no.body.error, /up to 20 rows/);
  assert.equal((await ann('POST', `/api/files/${bs.id}/sheet-slides`, { range: 'A1:A5' })).status, 201);
  // The document copy still works through the shared step.
  assert.equal((await ann('POST', `/api/files/${sh.id}/sheet-doc`, {})).status, 201);
});

test('workload in Sheets: a list’s and the team’s, a row per person with the counts as numbers', async () => {
  const ann = client(), mia = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const miaId = (await mia('GET', '/api/auth/me')).body.user.id;
  const list = (await ann('POST', '/api/tasks/lists', { name: 'Fair stand' })).body.id;
  assert.equal((await ann('POST', `/api/tasks/lists/${list}/workload/sheet`, { today: '2026-11-18' })).status, 400, 'nobody yet');
  await ann('PUT', `/api/tasks/lists/${list}/members`, { user_ids: [miaId] });
  await ann('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Build the stand', due: '2026-11-01', assignee_id: miaId });
  await ann('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Order flyers', assignee_id: miaId });
  const r = await ann('POST', `/api/tasks/lists/${list}/workload/sheet`, { today: '2026-11-18' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.name, 'Workload Fair stand 2026-11-18');
  const sh = (await ann('GET', `/api/files/${r.body.id}/content`)).body.content.sheets[0];
  assert.deepEqual(['A1', 'B1', 'C1'].map((k) => sh.cells[k]), ['Person', 'Open', 'Overdue']);
  const row = Object.keys(sh.cells).find((k) => sh.cells[k] === 'Mia Member').slice(1);
  assert.deepEqual(['B', 'C', 'G'].map((c) => sh.cells[`${c}${row}`]), ['2', '1', '1']);
  const team = await mia('POST', '/api/tasks/workload/sheet', { today: '2026-11-18' });
  assert.equal(team.status, 201, JSON.stringify(team.body));
  const ts = (await mia('GET', `/api/files/${team.body.id}/content`)).body.content.sheets[0];
  assert.deepEqual([ts.cells.A1, ts.cells.B1], ['Person', 'Lists']);
  const other = (await mia('POST', '/api/tasks/lists', { name: 'Mia own' })).body.id;
  assert.equal((await ann('POST', `/api/tasks/lists/${other}/workload/sheet`, {})).status, 404);
});

test('the storage report in Sheets (admins): a row per person in MB, biggest first, then everyone', async () => {
  const ann = client(), mia = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  assert.equal((await mia('POST', '/api/orgs/current/storage/sheet', {})).status, 403);
  const r = await ann('POST', '/api/orgs/current/storage/sheet', {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.name, /^Storage \d{4}-\d{2}-\d{2}/);
  const sh = (await ann('GET', `/api/files/${r.body.id}/content`)).body.content.sheets[0];
  assert.deepEqual(['A1', 'C1', 'G1'].map((k) => sh.cells[k]), ['Name', 'Total (MB)', 'Files']);
  const rows = Object.keys(sh.cells).filter((k) => /^A\d+$/.test(k)).map((k) => sh.cells[k]);
  assert.ok(rows.includes('Olivia Owner') && rows.includes('Mia Member'), rows.join());
  assert.equal(rows[rows.length - 1], 'Everyone');
  const olivia = Object.keys(sh.cells).find((k) => sh.cells[k] === 'Olivia Owner').slice(1);
  assert.ok(Number(sh.cells[`G${olivia}`]) > 0, 'she has files');
  assert.ok(!Number.isNaN(Number(sh.cells[`C${olivia}`])));
});

test('share links in Sheets (admins): the same rows as the CSV, a row a link; logged', async () => {
  const ann = client(), mia = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  await ann('PATCH', '/api/orgs/current', { allow_links: true });
  assert.equal((await mia('POST', '/api/links/all/sheet', {})).status, 403);
  const before = (await ann('GET', '/api/links/all')).body.length;
  if (!before) assert.equal((await ann('POST', '/api/links/all/sheet', {})).status, 400, 'no links yet');
  const f = (await mia('POST', '/api/files/new', { kind: 'doc', name: 'Price list' })).body;
  const l = await mia('POST', '/api/links', { file_id: f.id, password: 'pass-1234' });
  assert.ok(l.status < 300, JSON.stringify(l.body));
  const r = await ann('POST', '/api/links/all/sheet', {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.name, /^Share links \d{4}-\d{2}-\d{2}/);
  const sh = (await ann('GET', `/api/files/${r.body.id}/content`)).body.content.sheets[0];
  assert.deepEqual(['A1', 'C1', 'F1', 'J1'].map((k) => sh.cells[k]), ['File or folder', 'Made by', 'Password', 'Opened']);
  const row = Object.keys(sh.cells).find((k) => sh.cells[k] === 'Price list').slice(1);
  assert.deepEqual(['C', 'D', 'F', 'I', 'J'].map((c) => sh.cells[`${c}${row}`]), ['Mia Member', 'mia@acme.com', 'yes', 'no', '0']);
  assert.match(sh.cells[`E${row}`], /^\/s\//);
  // The CSV has the same heading row.
  const csv = await fetch(`${base}/api/links/all.csv`, { headers: { cookie: (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'olivia@acme.com', password: 'password123' }) })).headers.get('set-cookie').split(';')[0] } });
  assert.match(await csv.text(), /^﻿?File or folder,Kind,Made by,Email,Link,Password,/);
});

test('a colleague saved as a contact: name, address, work phone, job title and company; not twice, not yourself, not someone unknown', async () => {
  const ann = client(), mia = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const miaId = (await mia('GET', '/api/auth/me')).body.user.id, annId = (await ann('GET', '/api/auth/me')).body.user.id;
  assert.equal((await ann('PATCH', `/api/users/${miaId}`, { job_title: 'Buyer', work_phone: '+44 20 7946 0199' })).status, 200);
  const r = await ann('POST', '/api/contacts/from-colleague', { user_id: miaId });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.email, r.body.phone, r.body.title, r.body.company], ['Mia Member', 'mia@acme.com', '+44 20 7946 0199', 'Buyer', 'Acme']);
  const again = await ann('POST', '/api/contacts/from-colleague', { user_id: miaId });
  assert.deepEqual([again.status, again.body.already, again.body.id], [200, true, r.body.id]);
  assert.equal((await ann('GET', '/api/contacts')).body.filter((c) => c.email === 'mia@acme.com').length, 1);
  assert.equal((await ann('POST', '/api/contacts/from-colleague', { user_id: annId })).status, 400);
  assert.equal((await ann('POST', '/api/contacts/from-colleague', { user_id: 'nobody' })).status, 404);
});

test('the Directory in Sheets (anyone): a row per colleague with job title, phone as written and who they report to', async () => {
  const ann = client(), mia = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const miaId = (await mia('GET', '/api/auth/me')).body.user.id, annId = (await ann('GET', '/api/auth/me')).body.user.id;
  assert.equal((await ann('PATCH', `/api/users/${miaId}`, { job_title: 'Buyer', department: 'Purchasing', work_phone: '+44 20 7946 0199', manager_id: annId })).status, 200);
  const r = await mia('POST', '/api/users/directory/sheet', {}); // not an admin
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.name, /^Directory \d{4}-\d{2}-\d{2}/);
  const cells = (await mia('GET', `/api/files/${r.body.id}/content`)).body.content.sheets[0].cells;
  assert.deepEqual(['A1', 'B1', 'C1', 'D1', 'E1', 'F1'].map((k) => cells[k]), ['Name', 'Email', 'Job title', 'Department', 'Work phone', 'Reports to']);
  const row = Object.keys(cells).find((k) => cells[k] === 'Mia Member').slice(1);
  assert.deepEqual(['B', 'C', 'D', 'E', 'F'].map((c) => cells[`${c}${row}`]), ['mia@acme.com', 'Buyer', 'Purchasing', "'+44 20 7946 0199", 'Olivia Owner']);
  assert.equal(r.body.people, (await mia('GET', '/api/users/directory')).body.length);
});

test('a note’s unticked items to Tasks on the list you choose (yours or shared with you); your first list otherwise; not a stranger’s', async () => {
  const ann = client(), mia = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const note = (await ann('POST', '/api/notes', { title: 'Move', items: [{ text: 'Pack', done: false }, { text: 'Label boxes', done: true }, { text: 'Hire van', done: false }] })).body;
  const chosen = (await ann('POST', '/api/tasks/lists', { name: 'Moving day' })).body.id;
  const r = await ann('POST', `/api/notes/${note.id}/tasks`, { list_id: chosen });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.added, r.body.list.name], [2, 'Moving day']);
  assert.deepEqual((await ann('GET', `/api/tasks/lists/${chosen}/tasks`)).body.map((t) => t.title).sort(), ['Hire van', 'Pack']);
  // Each links back to the note.
  assert.deepEqual((await ann('GET', `/api/tasks/lists/${chosen}/tasks`)).body.map((t) => [t.link_url, t.link_label]), Array(2).fill([`/notes?note=${note.id}`, 'Note: Move']));
  const kept = (await ann('GET', `/api/tasks/lists/${chosen}/tasks`)).body[0];
  assert.equal((await ann('PATCH', `/api/tasks/tasks/${kept.id}`, { link: { url: kept.link_url, label: kept.link_label } })).status, 200, 'a link to a note is one a task may carry');
  // The note counts its open tasks (on lists you can see); ticking one off takes it out of the count.
  const counted = async (who) => (await who('GET', '/api/notes')).body.find((n) => n.id === note.id)?.tasks_open;
  assert.equal(await counted(ann), 2);
  assert.equal((await ann('PATCH', `/api/tasks/tasks/${kept.id}`, { done: true })).status, 200);
  assert.equal(await counted(ann), 1);
  assert.equal((await ann('PUT', `/api/notes/${note.id}/shares`, { user_ids: [(await mia('GET', '/api/auth/me')).body.user?.id || (await mia('GET', '/api/auth/me')).body.id] })).status, 200);
  assert.equal(await counted(mia), 0, 'someone the note is shared with sees none of your private tasks');
  // Without a list: the first list, as before.
  const first = await ann('POST', `/api/notes/${note.id}/tasks`, {});
  assert.equal(first.status, 201);
  assert.notEqual(first.body.list.id, chosen);
  // Not into someone else's list.
  const hers = (await mia('POST', '/api/tasks/lists', { name: 'Mia private' })).body.id;
  assert.equal((await ann('POST', `/api/notes/${note.id}/tasks`, { list_id: hers })).status, 404);
  assert.equal((await mia('GET', `/api/tasks/lists/${hers}/tasks`)).body.length, 0);
});

test('the list Add to Tasks uses: chosen (yours or shared with you), marked in the lists, used for a note’s items; back to the first list', async () => {
  const ann = client(), mia = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const marked = async () => (await ann('GET', '/api/tasks/lists')).body.lists.filter((l) => l.inbox).map((l) => l.id);
  const first = (await marked())[0];
  assert.ok(first, 'the first list to start with');
  const inbox = (await ann('POST', '/api/tasks/lists', { name: 'Inbox' })).body.id;
  const r = await ann('PUT', '/api/tasks/inbox', { list_id: inbox });
  assert.deepEqual([r.status, r.body.list.name], [200, 'Inbox']);
  assert.deepEqual(await marked(), [inbox]);
  // A note's items, with no list named, go there now.
  const note = (await ann('POST', '/api/notes', { title: 'Errand', items: [{ text: 'Post the parcel', done: false }] })).body;
  assert.equal((await ann('POST', `/api/notes/${note.id}/tasks`, {})).body.list.id, inbox);
  // Someone else's private list can't be chosen.
  const hers = (await mia('POST', '/api/tasks/lists', { name: 'Mia inbox' })).body.id;
  assert.equal((await ann('PUT', '/api/tasks/inbox', { list_id: hers })).status, 404);
  assert.deepEqual(await marked(), [inbox]);
  // The list deleted: back to the first; and null does the same.
  assert.equal((await ann('DELETE', `/api/tasks/lists/${inbox}`)).status, 200);
  assert.deepEqual(await marked(), [first]);
  const again = (await ann('POST', '/api/tasks/lists', { name: 'Inbox 2' })).body.id;
  await ann('PUT', '/api/tasks/inbox', { list_id: again });
  assert.equal((await ann('PUT', '/api/tasks/inbox', { list_id: null })).body.list.id, first);
});

test('a comment assigned to you becomes a task on the list you chose for Add to Tasks', async () => {
  const ann = client(), mia = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const miaId = (await mia('GET', '/api/auth/me')).body.user.id;
  const chosen = (await mia('POST', '/api/tasks/lists', { name: 'Reviews' })).body.id;
  assert.equal((await mia('PUT', '/api/tasks/inbox', { list_id: chosen })).status, 200);
  const doc = (await ann('POST', '/api/files/new', { kind: 'doc', name: 'Plan to review' })).body;
  assert.equal((await ann('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: miaId, role: 'editor' }] })).status, 200);
  const c = await ann('POST', `/api/comments/${doc.id}`, { body: 'Please check the dates', assign: miaId });
  assert.ok(c.status < 300, JSON.stringify(c.body));
  const there = (await mia('GET', `/api/tasks/lists/${chosen}/tasks`)).body;
  assert.equal(there.length, 1, JSON.stringify(there));
  assert.match(there[0].title, /check the dates/i);
  await mia('PUT', '/api/tasks/inbox', { list_id: null });
});

test('a group’s members added to Contacts: new ones by name, colleagues and existing contacts left out; only your own group', async () => {
  const ann = client(), mia = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  await ann('POST', '/api/contacts', { name: 'Yan Known', email: 'yan@club.example' });
  const g = (await ann('POST', '/api/contacts/groups', { name: 'Book club', members: [
    { name: 'Zoe Zest', email: 'zoe@club.example' }, { name: '', email: 'abe@club.example' }, { name: 'Yan', email: 'yan@club.example' }, { name: 'Mia Member', email: 'mia@acme.com' }] })).body;
  const r = await ann('POST', `/api/contacts/groups/${g.id}/add-to-contacts`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.added, r.body.skipped, r.body.names], [2, 2, ['Zoe Zest', 'abe']]);
  const mine = (await ann('GET', '/api/contacts')).body;
  assert.ok(mine.some((c) => c.email === 'zoe@club.example' && c.name === 'Zoe Zest'));
  assert.equal(mine.filter((c) => c.email === 'yan@club.example').length, 1);
  assert.deepEqual((await ann('POST', `/api/contacts/groups/${g.id}/add-to-contacts`, {})).body.added, 0);
  assert.equal((await mia('POST', `/api/contacts/groups/${g.id}/add-to-contacts`, {})).status, 404);
  const empty = (await ann('POST', '/api/contacts/groups', { name: 'Empty club', members: [] })).body;
  assert.equal((await ann('POST', `/api/contacts/groups/${empty.id}/add-to-contacts`, {})).status, 400);
});

test('a document’s action item for you becomes a task on the list you chose for Add to Tasks', async () => {
  const ann = client(), mia = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const miaId = (await mia('GET', '/api/auth/me')).body.user.id;
  const chosen = (await mia('POST', '/api/tasks/lists', { name: 'From meetings' })).body.id;
  assert.equal((await mia('PUT', '/api/tasks/inbox', { list_id: chosen })).status, 200);
  const doc = (await ann('POST', '/api/files/new', { kind: 'doc', name: 'Minutes' })).body;
  const r = await ann('POST', `/api/tasks/from-doc/${doc.id}`, { items: [{ user_id: miaId, title: 'Send the revised quote', text: 'Mia: send the revised quote' }] });
  assert.ok(r.status < 300, JSON.stringify(r.body));
  const there = (await mia('GET', `/api/tasks/lists/${chosen}/tasks`)).body.map((t) => t.title);
  assert.deepEqual(there, ['Send the revised quote']);
  await mia('PUT', '/api/tasks/inbox', { list_id: null });
});

test('a shared list says who to write to: its owner’s address and each member’s, for Email the list’s people', async () => {
  const ann = client(), mia = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const miaId = (await mia('GET', '/api/auth/me')).body.user.id;
  const list = (await ann('POST', '/api/tasks/lists', { name: 'Stand crew' })).body.id;
  await ann('PUT', `/api/tasks/lists/${list}/members`, { user_ids: [miaId] });
  const seen = (await mia('GET', '/api/tasks/lists')).body.lists.find((l) => l.id === list);
  assert.deepEqual([seen.owner_email, seen.owner_name, seen.members.map((m) => m.username)], ['olivia@acme.com', 'Olivia Owner', ['mia@acme.com']]);
});

test('a task can link back to a calendar event (as to an email or a chat message); other links are still refused', async () => {
  const ann = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  const list = (await ann('POST', '/api/tasks/lists', { name: 'Prep' })).body.id;
  const r = await ann('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Board meeting', due: '2026-12-03', due_time: '14:00', link: { url: '/calendar?event=abc123&at=1796306400000', label: 'Event: Board meeting' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.link_url, r.body.link_label, r.body.due, r.body.due_time], ['/calendar?event=abc123&at=1796306400000', 'Event: Board meeting', '2026-12-03', '14:00']);
  assert.equal((await ann('POST', `/api/tasks/lists/${list}/tasks`, { title: 'x', link: { url: 'https://evil.example/calendar', label: 'x' } })).status, 400);
  assert.equal((await ann('POST', `/api/tasks/lists/${list}/tasks`, { title: 'x', link: { url: '/admin', label: 'x' } })).status, 400);
  // And to a file in Drive (a spreadsheet, a presentation, a folder or a preview), to a contact, or to a form's response.
  for (const url of ['/sheets/abc', '/slides/abc', '/drive/folder/abc', '/drive?preview=abc', '/contacts?q=Dana%20Reed', '/forms/abc?tab=responses&r=def', '/notes?note=abc']) {
    const f = await ann('POST', `/api/tasks/lists/${list}/tasks`, { title: `Review ${url}`, link: { url, label: 'File: Budget' } });
    assert.deepEqual([f.status, f.body.link_url], [201, url], url);
  }
  assert.equal((await ann('POST', `/api/tasks/lists/${list}/tasks`, { title: 'x', link: { url: '/sheetsx/abc', label: 'x' } })).status, 400);
});

test('tasks about something: the open ones that link to it, on lists you can see', async () => {
  const ann = client(), mia = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const list = (await ann('POST', '/api/tasks/lists', { name: 'About things' })).body.id;
  const add = (who, l, title, url) => who('POST', `/api/tasks/lists/${l}/tasks`, { title, link: { url, label: 'File: Plan' } });
  const one = (await add(ann, list, 'Review the plan', '/docs/plan1')).body;
  const two = (await add(ann, list, 'Sign off the plan', '/docs/plan1')).body;
  await add(ann, list, 'Another file', '/docs/plan2');
  const hers = (await mia('POST', '/api/tasks/lists', { name: 'Mia about' })).body.id;
  await add(mia, hers, 'Mia reads the plan', '/docs/plan1');
  const about = async (who, url) => (await who('GET', `/api/tasks/about?url=${encodeURIComponent(url)}`));
  assert.deepEqual((await about(ann, '/docs/plan1')).body.map((t) => t.title).sort(), ['Review the plan', 'Sign off the plan']);
  assert.equal((await about(ann, '/docs/plan1')).body[0].list_id, list);
  // Done ones drop out; each person sees only tasks on lists they can see.
  assert.equal((await ann('PATCH', `/api/tasks/tasks/${two.id}`, { done: true })).status, 200);
  assert.deepEqual((await about(ann, '/docs/plan1')).body.map((t) => t.id), [one.id]);
  assert.deepEqual((await about(mia, '/docs/plan1')).body.map((t) => t.title), ['Mia reads the plan']);
  assert.deepEqual((await about(ann, '/docs/none')).body, []);
  assert.equal((await about(ann, '/admin')).status, 400);
  assert.equal((await about(ann, '')).status, 400);
});
