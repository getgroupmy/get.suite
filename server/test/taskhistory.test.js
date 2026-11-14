import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-taskhist-'));
const { createApp } = await import('../src/app.js');
const { recordChanges, historyOf, listActivity, MERGE_MS } = await import('../src/taskhistory.js');
const { q } = await import('../src/db.js');

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


test('task history: who changed what, quick changes in a row as one, kept through the trash, private to the list', async () => {
  const ana = client(), ben = client(), out = client();
  await ana('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ana Silva', local: 'ana', password: 'password123' });
  const id = {};
  for (const [c, local, name] of [[ben, 'ben', 'Ben Ode'], [out, 'zed', 'Zed Other']]) {
    id[local] = (await ana('POST', '/api/users', { local, domain: 'acme.com', name, password: 'password123' })).body.id;
    assert.equal((await c('POST', '/api/auth/login', { username: `${local}@acme.com`, password: 'password123' })).status, 200);
  }
  const list = (await ana('POST', '/api/tasks/lists', { name: 'Launch' })).body.id;
  const other = (await ana('POST', '/api/tasks/lists', { name: 'Later' })).body.id;
  assert.equal((await ana('PUT', `/api/tasks/lists/${list}/members`, { user_ids: [id.ben] })).status, 200);
  const t = (await ana('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Book venue' })).body;
  const hist = async (who = ana) => (await who('GET', `/api/tasks/tasks/${t.id}/history`)).body;
  const h0 = await hist();
  assert.equal(h0.created_by_name, 'Ana Silva');
  assert.deepEqual(h0.entries, [], 'nothing changed yet');

  // Ana sets a due date, then changes it again straight away: one entry, from nothing to the last date.
  await ana('PATCH', `/api/tasks/tasks/${t.id}`, { due: '2026-12-01' });
  await ana('PATCH', `/api/tasks/tasks/${t.id}`, { due: '2026-12-03', due_time: '15:00' });
  // Ben takes it on, sets a priority, adds tags, and ticks it off; then Undo: the ticking isn't there.
  await ben('PATCH', `/api/tasks/tasks/${t.id}`, { assignee_id: id.ben, priority: 'high', tags: ['venue', 'q4'] });
  await ben('PATCH', `/api/tasks/tasks/${t.id}`, { done: true });
  await ben('PATCH', `/api/tasks/tasks/${t.id}`, { done: false });
  await ben('PATCH', `/api/tasks/tasks/${t.id}`, { notes: 'Ask for the big room' });
  await ben('PATCH', `/api/tasks/tasks/${t.id}`, { notes: 'Ask for the big room, and a projector' });
  // Dragging it about isn't history.
  await ben('PATCH', `/api/tasks/tasks/${t.id}`, { position: 5 });
  const h1 = (await hist(ben)).entries;
  assert.deepEqual(h1.map((e) => [e.user.name, e.field]), [['Ben Ode', 'notes'], ['Ben Ode', 'tags'], ['Ben Ode', 'priority'], ['Ben Ode', 'assignee'], ['Ana Silva', 'due']]);
  const by = Object.fromEntries(h1.map((e) => [e.field, e]));
  assert.deepEqual([by.due.before, by.due.after], [null, '2026-12-03 15:00']);
  assert.deepEqual(by.assignee.after, { id: id.ben, name: 'Ben Ode' });
  assert.equal(by.assignee.before, null);
  assert.deepEqual([by.priority.before, by.priority.after], [null, 'high']);
  assert.deepEqual([by.tags.before, by.tags.after.sort()], [[], ['q4', 'venue']]);
  assert.deepEqual([by.notes.before, by.notes.after], [null, '1'], "notes are just changed: their words aren't kept again");

  // Someone not on the list can't read it.
  assert.equal((await out('GET', `/api/tasks/tasks/${t.id}/history`)).status, 404);

  // Status, moving to another list (and a section there is the list's own), several at once.
  await ana('PATCH', `/api/tasks/tasks/${t.id}`, { started: true });
  await ana('POST', '/api/tasks/tasks/batch', { ids: [t.id], change: { list_id: other } });
  const h2 = (await hist()).entries;
  assert.deepEqual(h2.slice(0, 3).map((e) => [e.field, e.before, e.after]).sort((x, y) => x[0].localeCompare(y[0])),
    [['assignee', { id: id.ben, name: 'Ben Ode' }, null], ['list', 'Launch', 'Later'], ['status', 'todo', 'progress']],
    'Ben is not on Later, so it is nobody’s any more');
  assert.equal((await ben('GET', `/api/tasks/tasks/${t.id}/history`)).status, 404, 'Ben can’t see it on Ana’s other list');

  // Deleted and put back: the history comes back with it.
  await ana('DELETE', `/api/tasks/tasks/${t.id}`);
  assert.equal((await hist()).entries, undefined);
  assert.equal((await ana('POST', `/api/tasks/trash/${t.id}/restore`)).status, 200);
  assert.equal((await hist()).entries.length, h2.length);
  // A list deleted with its tasks: their history goes too.
  await ana('DELETE', `/api/tasks/lists/${other}`);
  assert.equal(q('SELECT COUNT(*) AS n FROM task_history WHERE task_id = ?').get(t.id).n, 0);
});

test('task history: steps, files, what it waits on, and skipping a repeat', async () => {
  const me = client();
  assert.equal((await me('POST', '/api/auth/login', { username: 'ben@acme.com', password: 'password123' })).status, 200);
  const list = (await me('POST', '/api/tasks/lists', { name: 'Steps' })).body.id;
  const design = (await me('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Design' })).body;
  const t = (await me('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Print flyers', due: '2026-12-01', repeat: 'weekly' })).body;
  const entries = async () => (await me('GET', `/api/tasks/tasks/${t.id}/history`)).body.entries;
  // Steps added one after another are one entry; ticking one off is part of it; moving one isn't a change.
  const a = (await me('POST', `/api/tasks/tasks/${t.id}/steps`, { title: 'Proof' })).body.steps[0].id;
  await me('POST', `/api/tasks/tasks/${t.id}/steps`, { title: 'Order paper' });
  await me('PATCH', `/api/tasks/tasks/${t.id}/steps/${a}`, { done: true });
  const before = await entries();
  await me('PATCH', `/api/tasks/tasks/${t.id}/steps/${a}`, { index: 1 });
  assert.deepEqual(await entries(), before, 'reordering steps is not history');
  assert.equal(before.length, 1);
  assert.deepEqual(before[0].before, []);
  assert.deepEqual(before[0].after.map((x) => [x.title, x.done]), [['Proof', true], ['Order paper', false]], 'in the checklist’s order');
  // Waiting on another task, by its title (and still named once that task is deleted).
  await me('PUT', `/api/tasks/tasks/${t.id}/waiting-on`, { task_ids: [design.id] });
  await me('DELETE', `/api/tasks/tasks/${design.id}`);
  const w = (await entries()).find((e) => e.field === 'waiting');
  assert.deepEqual(w.after, [{ id: design.id, title: 'Design' }]);
  // A file attached, by its name.
  const f = (await me('POST', '/api/files/new', { kind: 'doc', name: 'Flyer text' })).body.id;
  assert.equal((await me('POST', `/api/tasks/tasks/${t.id}/attachments`, { file_id: f })).status, 201);
  assert.deepEqual((await entries())[0].after, [{ id: f, name: 'Flyer text' }]);
  // Skipping this time moves the due date: that's history too.
  assert.equal((await me('POST', `/api/tasks/tasks/${t.id}/skip`, { today: '2026-11-14' })).status, 200);
  const d = (await entries())[0];
  assert.deepEqual([d.field, d.before, d.after], ['due', '2026-12-01', '2026-12-08']);
});

test('list activity: changes, tasks added and deleted, newest first, a page at a time; for people on the list', async () => {
  const ana = client(), zed = client();
  assert.equal((await ana('POST', '/api/auth/login', { username: 'ana@acme.com', password: 'password123' })).status, 200);
  assert.equal((await zed('POST', '/api/auth/login', { username: 'zed@acme.com', password: 'password123' })).status, 200);
  const list = (await ana('POST', '/api/tasks/lists', { name: 'Activity' })).body.id;
  const a = (await ana('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Alpha' })).body;
  const b = (await ana('POST', `/api/tasks/lists/${list}/tasks`, { title: 'Beta' })).body;
  await ana('PATCH', `/api/tasks/tasks/${a.id}`, { done: true });
  await ana('DELETE', `/api/tasks/tasks/${b.id}`);
  const act = (await ana('GET', `/api/tasks/lists/${list}/activity`)).body;
  assert.deepEqual(act.entries.map((e) => [e.field, e.task.title, e.task.gone, e.user.name]),
    [['deleted', 'Beta', true, 'Ana Silva'], ['status', 'Alpha', false, 'Ana Silva'], ['added', 'Beta', true, 'Ana Silva'], ['added', 'Alpha', false, 'Ana Silva']]);
  assert.equal(act.more, false);
  assert.equal((await zed('GET', `/api/tasks/lists/${list}/activity`)).status, 404, 'not on the list');
  assert.equal((await ana('GET', `/api/tasks/lists/${list}/activity?before=soon`)).status, 400);

  // Pages: never split a moment between them, and every entry is seen once.
  const t0 = Date.now() + 1e6;
  for (let i = 0; i < 60; i++) q('INSERT INTO task_history (task_id, user_id, at, field, before, after) VALUES (?, NULL, ?, ?, NULL, ?)').run(a.id, t0 + Math.floor(i / 3), 'title', `T${i}`);
  const seen = [];
  let page = listActivity(list, { limit: 50 });
  seen.push(...page.entries);
  assert.equal(page.more, true);
  assert.ok(page.entries.length >= 50);
  page = listActivity(list, { before: page.before, limit: 50 });
  seen.push(...page.entries);
  assert.equal(page.more, false);
  assert.equal(seen.length, 64, 'all 60 and the 4 from before, none twice');
  assert.equal(new Set(seen.map((e) => `${e.at}${e.field}${e.after}`)).size, 64);
});

test('Download your data: Task history.csv, oldest first, as plain text', async () => {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ben@acme.com', password: 'password123' }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const zipRes = await fetch(`${base}/api/takeout`, { headers: { cookie, 'x-requested-with': 'nas-workspace' } });
  assert.equal(zipRes.status, 200);
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(Buffer.from(await zipRes.arrayBuffer()));
  const csv = await zip.file('Task history.csv').async('string');
  const lines = csv.replace(/^\ufeff/, '').trim().split('\r\n');
  assert.equal(lines[0], 'List,Task,When (UTC),Who,What,Before,After');
  const steps = lines.filter((l) => l.startsWith('Steps,Print flyers'));
  assert.ok(steps.some((l) => l.includes('Added,')), 'the task added');
  assert.ok(steps.some((l) => /,Steps,,(✓ Proof; Order paper|Order paper; ✓ Proof)$/.test(l)), steps.join('\n'));
  assert.ok(steps.some((l) => /,Waiting on,,Design$/.test(l)));
  assert.ok(steps.some((l) => /,Due,2026-12-01,2026-12-08$/.test(l)), 'the skip');
  assert.ok(lines.some((l) => /^Steps,Design \(deleted\),.*,Deleted,,$/.test(l)));
  assert.ok(!csv.includes('Launch'), 'Ana’s list is hers, not in Ben’s download');
  assert.match(await zip.file('README.txt').async('string'), /Task history\.csv/);
});

test('task history: entries far apart stay apart; changing it back by someone else is its own entry; at most 200 kept', () => {
  const row = (x) => ({ id: 'tk1', title: 'A', notes: null, due: null, due_time: null, start: null, assignee_id: null, done_at: null, started: 0, priority: null, important: 0, list_id: 'l', section_id: null, repeat: null, tags: null, estimate: null, ...x });
  const u = q('SELECT id FROM users LIMIT 2').all().map((x) => x.id);
  recordChanges(row(), row({ title: 'B' }), u[0], 1000);
  recordChanges(row({ title: 'B' }), row({ title: 'C' }), u[0], 1000 + MERGE_MS + 1);
  recordChanges(row({ title: 'C' }), row({ title: 'B' }), u[1], 1000 + MERGE_MS + 2);
  assert.deepEqual(historyOf('tk1').map((e) => [e.before, e.after]), [['C', 'B'], ['B', 'C'], ['A', 'B']]);
  // Same person, same thing, back as it was within minutes: nothing happened.
  recordChanges(row(), row({ important: 1 }), u[0], 1e7);
  recordChanges(row({ important: 1 }), row(), u[0], 1e7 + 1000);
  assert.equal(historyOf('tk1').length, 3);
  for (let i = 0; i < 210; i++) recordChanges(row({ estimate: i }), row({ estimate: i + 1 }), u[i % 2], 2e7 + i * 2 * MERGE_MS);
  const all = historyOf('tk1');
  assert.equal(all.length, 200);
  assert.equal(all[0].after, 210, 'the newest kept');
  q("DELETE FROM task_history WHERE task_id = 'tk1'").run();
});
