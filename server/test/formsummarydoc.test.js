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

test('respondents to Contacts: collected addresses, named from the Name question; colleagues and contacts left out', async () => {
  const olivia = client(), anon = client();
  assert.equal((await olivia('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  await olivia('PATCH', '/api/orgs/current', { allow_links: true });
  const made = (await olivia('POST', '/api/forms', { title: 'Open day sign-up' })).body;
  const f = (await olivia('PUT', `/api/forms/${made.id}`, { audience: 'public', collect_email: true, questions: [
    { id: 'company', type: 'short', title: 'Company name' }, { id: 'who', type: 'short', title: 'Your name' }, { id: 'diet', type: 'paragraph', title: 'Dietary needs' },
  ] })).body;
  assert.equal(f.audience, 'public', JSON.stringify(f));
  assert.equal((await olivia('POST', `/api/forms/${f.id}/contacts`, {})).status, 400, 'no responses yet');
  await olivia('POST', '/api/contacts', { name: 'Ray Known', email: 'ray@guest.example' });
  for (const [email, who] of [['Sam@Guest.example', 'Sam Stone'], ['ray@guest.example', 'Ray R'], ['mia@acme.com', 'Mia'], ['tess@guest.example', '']]) {
    const r = await anon('POST', `/api/public/forms/${f.token}`, { email, answers: { company: 'Guest Co', who } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const r = await olivia('POST', `/api/forms/${f.id}/contacts`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.added, r.body.skipped, r.body.names, r.body.with_email], [2, 2, ['Sam Stone', 'tess'], 4]);
  const mine = (await olivia('GET', '/api/contacts')).body;
  assert.ok(mine.some((c) => c.email === 'sam@guest.example' && c.name === 'Sam Stone'));
  assert.ok(!mine.some((c) => c.email === 'mia@acme.com'), 'a colleague');
  assert.equal(mine.filter((c) => c.email === 'ray@guest.example').length, 1);
  assert.deepEqual((await olivia('POST', `/api/forms/${f.id}/contacts`, {})).body.added, 0, 'again: nobody new');
  // A company form asking for an email in a question.
  const mia = client();
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const g = (await olivia('PUT', `/api/forms/${(await olivia('POST', '/api/forms', { title: 'Referrals' })).body.id}`, { questions: [{ id: 'n', type: 'short', title: 'Name' }, { id: 'e', type: 'short', title: 'Their email' }] })).body;
  assert.equal((await mia('POST', `/api/public/forms/${g.token}`, { answers: { n: 'Uma Upton', e: 'uma@ref.example' } })).status, 201);
  const r2 = await olivia('POST', `/api/forms/${g.id}/contacts`, {});
  assert.deepEqual([r2.body.added, r2.body.names], [1, ['Uma Upton']], 'a colleague’s response: the address they gave, not their own');
  assert.equal((await mia('POST', `/api/forms/${f.id}/contacts`, {})).status, 404, 'only those who can edit the form');
});

test('the summary as a presentation: a title slide, then a chart of each choice question and the typed answers as points', async () => {
  const olivia = client(), mia = client();
  assert.equal((await olivia('POST', '/api/auth/login', { username: 'olivia@acme.com', password: 'password123' })).status, 200);
  assert.equal((await mia('POST', '/api/auth/login', { username: 'mia@acme.com', password: 'password123' })).status, 200);
  const made = (await olivia('POST', '/api/forms', { title: 'Offsite vote' })).body;
  const f = (await olivia('PUT', `/api/forms/${made.id}`, { questions: [
    { id: 'where', type: 'choice', title: 'Where?', options: ['Lake', 'City'] },
    { id: 'idea', type: 'paragraph', title: 'One idea' },
  ] })).body;
  assert.equal((await olivia('POST', `/api/forms/${f.id}/summary-slides`, {})).status, 400, 'nothing yet');
  for (const a of [{ where: 'Lake', idea: 'Kayaks' }, { where: 'Lake' }, { where: 'City', idea: 'A museum' }]) assert.equal((await mia('POST', `/api/public/forms/${f.token}`, { answers: a })).status, 201);
  const r = await olivia('POST', `/api/forms/${f.id}/summary-slides`, { tz: 'UTC' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.name, 'Offsite vote (results)');
  const deck = (await olivia('GET', `/api/files/${r.body.id}/content`)).body.content;
  assert.equal(deck.slides.length, 3);
  assert.deepEqual(deck.slides[0].items.map((x) => x.text), ['Offsite vote', `3 responses, as of ${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'long' }).format(new Date())}`]);
  const chart = deck.slides[1].items.find((x) => x.type === 'chart');
  assert.deepEqual([chart.chartType, chart.data.categories, chart.data.series[0].values], ['bar', ['Lake', 'City'], [2, 1]]);
  assert.equal(deck.slides[1].items.find((x) => x.role === 'title').text, 'Where?');
  assert.equal(deck.slides[2].items.find((x) => x.role === 'body' && x.list).text, 'Kayaks\nA museum');
  assert.equal((await mia('POST', `/api/forms/${f.id}/summary-slides`, {})).status, 404, 'only those who can edit the form');
});
