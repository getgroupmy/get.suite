import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-taskhist-'));
const { createApp } = await import('../src/app.js');
const { recordChanges, historyOf, MERGE_MS } = await import('../src/taskhistory.js');
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
