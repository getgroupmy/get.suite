// Docs → Make a presentation: a slide for each Heading 1, what's under it as points (docslides.js), made beside the document.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-docslides-'));
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
const login = async (who, email) => assert.equal((await who('POST', '/api/auth/login', { username: email, password: 'password123' })).status, 200);
import { deckFromDoc, MAX_POINTS } from '../src/office/docslides.js';

const P = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const H = (level, text) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const L = (type, items, attrs = {}) => ({ type, attrs, content: items.map((x) => ({ type: type === 'taskList' ? 'taskItem' : 'listItem', content: Array.isArray(x) ? [P(x[0]), x[1]] : [P(x)] })) });
const doc = { type: 'doc', content: [
  P('Our plan for next year'), P('(not on the title slide: only the first paragraph)'),
  H(1, 'Goals'), P('Grow steadily.'), L('bulletList', [['Customers', L('bulletList', ['Retail', 'Online'])], 'Hiring']),
  H(1, 'Steps'), L('orderedList', ['Plan', 'Build', 'Launch'], { listStyle: 'lower-roman' }), H(2, 'Risks'), L('taskList', ['Budget']),
  H(1, 'Thanks'),
] };

test('the outline as slides: a title slide, a slide a Heading 1, what’s under it as points (lists inside lists a level in)', () => {
  const d = deckFromDoc(doc, 'Plan 2027');
  const show = d.slides.map((s) => s.items.map((it) => `${it.role}${it.list ? `[${it.list}]` : ''}:${it.text}`));
  assert.deepEqual(show, [
    ['title:Plan 2027', 'subtitle:Our plan for next year'],
    ['title:Goals', 'body[disc]:Grow steadily.\nCustomers\n\tRetail\n\tOnline\nHiring'],
    ['title:Steps', 'body[lower-roman]:Plan\nBuild\nLaunch\nRisks\nBudget'],
    ['title:Thanks'],
  ]);
  assert.ok(new Set(d.slides.flatMap((s) => [s.id, ...s.items.map((it) => it.id)])).size === d.slides.length + d.slides.reduce((n, s) => n + s.items.length, 0), 'ids all different');
});

test('a long section carries on in “(cont.)”; no headings: just the title slide', () => {
  const many = { type: 'doc', content: [H(1, 'Many'), L('bulletList', Array.from({ length: MAX_POINTS + 3 }, (_, i) => `Point ${i + 1}`))] };
  const d = deckFromDoc(many, 'X');
  assert.deepEqual(d.slides.slice(1).map((s) => [s.items[0].text, s.items[1].text.split('\n').length]), [['Many', MAX_POINTS], ['Many (cont.)', 3]]);
  assert.equal(deckFromDoc({ type: 'doc', content: [P('just words')] }, 'X').slides.length, 1);
});

let ann, ben, docId, folder;
test('Make a presentation: beside the document, for editors and viewers (not where copying is turned off)', async () => {
  ann = client();
  assert.equal((await ann('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ann Owner', local: 'ann', password: 'password123' })).status, 200);
  const benId = (await ann('POST', '/api/users', { local: 'ben', domain: 'acme.com', name: 'Ben Bell', password: 'password123' })).body.id;
  ben = client(); await login(ben, 'ben@acme.com');
  folder = (await ann('POST', '/api/files/folder', { name: 'Planning' })).body.id;
  docId = (await ann('POST', '/api/files/new', { kind: 'doc', name: 'Plan 2027', parent_id: folder, content: doc })).body.id;
  const r = await ann('POST', `/api/files/${docId}/make-slides`);
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Plan 2027 (slides)');
  assert.equal(r.body.kind, 'slides');
  assert.equal(r.body.parent_id, folder);
  assert.equal(r.body.slides, 4);
  const deck = (await ann('GET', `/api/files/${r.body.id}/content`)).body.content;
  assert.equal(deck.slides[1].items[1].text, 'Grow steadily.\nCustomers\n\tRetail\n\tOnline\nHiring');
  // A viewer: theirs, in My Drive (they can't add to the folder); not when the owner turned copying off.
  await ann('PUT', `/api/files/${docId}/shares`, { shares: [{ user_id: benId, role: 'viewer' }] });
  const v = await ben('POST', `/api/files/${docId}/make-slides`);
  assert.equal(v.status, 201);
  assert.equal(v.body.parent_id, null);
  await ann('PATCH', `/api/files/${docId}`, { no_download: true });
  assert.equal((await ben('POST', `/api/files/${docId}/make-slides`)).status, 403);
  // Not a document; no headings.
  assert.equal((await ann('POST', `/api/files/${r.body.id}/make-slides`)).status, 400);
  const bare = (await ann('POST', '/api/files/new', { kind: 'doc', name: 'Bare', content: { type: 'doc', content: [P('no headings')] } })).body.id;
  const none = await ann('POST', `/api/files/${bare}/make-slides`);
  assert.equal(none.status, 400); assert.match(none.body.error, /Heading 1/);
});
