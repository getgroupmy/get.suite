// Forms → Summary as a document: a table per question of how the answers went, typed answers listed, a document of yours.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-formsumdoc-'));
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

test('the summary as a document: a table per choice question, the average on a scale, typed answers listed', async () => {
  const olivia = client(), mia = client();
  assert.equal((await olivia('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  assert.equal((await olivia('POST', '/api/users', { local: 'mia', domain: 'acme.com', name: 'Mia Member', password: 'password123' })).status, 201);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const made = (await olivia('POST', '/api/forms', { title: 'Team lunch' })).body;
  const f = (await olivia('PUT', `/api/forms/${made.id}`, { questions: [
    { id: 'where', type: 'choice', title: 'Where?', options: ['Pizza', 'Sushi'] },
    { id: 'stars', type: 'rating', title: 'How was the last one?', max: 5 },
    { id: 'note', type: 'paragraph', title: 'Anything else?' },
  ] })).body;
  assert.equal((await olivia('POST', `/api/forms/${f.id}/summary-doc`, {})).status, 400, 'nothing to sum up yet');
  for (const a of [{ where: 'Pizza', stars: 4, note: 'Earlier please' }, { where: 'Pizza', stars: 5 }, { where: 'Sushi', stars: 3, note: 'Vegan options' }]) {
    assert.equal((await mia('POST', `/api/public/forms/${f.token}`, { answers: a })).status, 201);
  }
  const r = await olivia('POST', `/api/forms/${f.id}/summary-doc`, { tz: 'Europe/London' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.name, 'Team lunch (summary)');
  const doc = (await olivia('GET', `/api/files/${r.body.id}/content`)).body.content;
  const text = (n) => (n.text || '') + (n.content || []).map(text).join(n.type === 'tableRow' ? '|' : n.type === 'table' || n.type === 'bulletList' ? '/' : '');
  const blocks = doc.content.map((n) => `${n.type}:${text(n)}`);
  assert.deepEqual(blocks.slice(0, 2), ['heading:Team lunch', `paragraph:3 responses, as of ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', dateStyle: 'long' }).format(new Date())}`]);
  assert.ok(blocks.includes('table:Answer|Responses|Share/Pizza|2|67%/Sushi|1|33%'), blocks.join('\n'));
  assert.ok(blocks.includes('paragraph:Average: 4'));
  assert.ok(blocks.includes('bulletList:Earlier please/Vegan options'));
  assert.ok(doc.content.find((n) => n.type === 'table').content[0].content.every((c) => c.type === 'tableHeader'), 'a heading row');
  // Only for whoever can edit the form.
  assert.equal((await mia('POST', `/api/forms/${f.id}/summary-doc`, {})).status, 404);
});
