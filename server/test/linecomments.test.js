// Comments on a line of a text file in Drive: the comment keeps { line, text } so the viewer can follow the line.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-linecomm-'));
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
  return async (method, url, body, raw) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', ...(raw ? {} : { 'content-type': 'application/json' }), ...(cookie && { cookie }) }, body: raw || (body === undefined ? undefined : JSON.stringify(body)) });
    const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}


test('a comment on a line of a text file keeps the line’s number and how it read', async () => {
  const ann = client();
  assert.equal((await ann('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ann Owner', local: 'ann', password: 'password123' })).status, 200);
  const benId = (await ann('POST', '/api/users', { local: 'ben', domain: 'acme.com', name: 'Ben Member', password: 'password123' })).body.id;
  const ben = client(); assert.equal((await ben('POST', '/api/auth/login', { username: 'ben@acme.com', password: 'password123' })).status, 200);
  const f = (await ann('POST', '/api/files/upload?name=report.py', null, Buffer.from('a = 1\n  b = 2  \nprint(a + b)\n'))).body;
  const c = await ann('POST', `/api/comments/${f.id}`, { body: 'Why 2?', anchor: { line: 2, text: '  b = 2  ', x: 5, junk: true } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.deepEqual(c.body.comment.anchor, { line: 2, text: '  b = 2  ' }, 'the text is kept as it was, spaces included, and nothing else');
  // Listed with its place; a reply joins the thread.
  assert.equal((await ann('POST', `/api/comments/${f.id}`, { body: 'It was 3 before', thread_id: c.body.comment.id })).status, 201);
  const list = (await ann('GET', `/api/comments/${f.id}`)).body;
  assert.deepEqual(list.find((x) => x.id === c.body.comment.id).anchor, { line: 2, text: '  b = 2  ' });
  // Long lines are kept by their start; a line with no text given is kept as empty.
  const long = (await ann('POST', `/api/comments/${f.id}`, { body: 'Long', anchor: { line: 3, text: 'x'.repeat(900) } })).body.comment;
  assert.equal(long.anchor.text.length, 300);
  assert.deepEqual((await ann('POST', `/api/comments/${f.id}`, { body: 'Blank', anchor: { line: 1 } })).body.comment.anchor, { line: 1, text: '' });
  // Not a line.
  for (const line of [0, -1, 1.5, 'two', 1e9, null]) {
    const r = await ann('POST', `/api/comments/${f.id}`, { body: 'x', anchor: { line } });
    assert.equal(r.status, 400, `line ${line}`);
    assert.match(r.body.error, /Comment on a line of the file/);
  }
  // Someone who may only view can't comment on a line; a commenter can.
  await ann('PUT', `/api/files/${f.id}/shares`, { shares: [{ user_id: benId, role: 'viewer' }] });
  assert.equal((await ben('POST', `/api/comments/${f.id}`, { body: 'Me too', anchor: { line: 1, text: 'a = 1' } })).status, 403);
  await ann('PUT', `/api/files/${f.id}/shares`, { shares: [{ user_id: benId, role: 'commenter' }] });
  const b = await ben('POST', `/api/comments/${f.id}`, { body: 'Me too', anchor: { line: 1, text: 'a = 1' } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  // The whole file and a spot on a picture still work as before.
  assert.deepEqual((await ann('POST', `/api/comments/${f.id}`, { body: 'All of it', anchor: {} })).body.comment.anchor, {});
  assert.deepEqual((await ann('POST', `/api/comments/${f.id}`, { body: 'Spot', anchor: { x: 10, y: 20 } })).body.comment.anchor, { x: 10, y: 20 });
});

test('a link to a line, in words (for Chat cards): how the line reads now; only for those who can open the file', async () => {
  const ann = client(); assert.equal((await ann('POST', '/api/auth/login', { username: 'ann@acme.com', password: 'password123' })).status, 200);
  const ben = client(); assert.equal((await ben('POST', '/api/auth/login', { username: 'ben@acme.com', password: 'password123' })).status, 200);
  const f = (await ann('POST', '/api/files/upload?name=deploy.yaml', null, Buffer.from(`replicas: 2\n\n  image: "shop:1.4"  \n${'x'.repeat(200)}\n`))).body;
  const place = async (who, line) => (await who('GET', `/api/files/${f.id}/place?line=${line}`));
  assert.deepEqual((await place(ann, 1)).body, { words: 'Line 1: “replicas: 2”' });
  assert.deepEqual((await place(ann, 2)).body, { words: 'Line 2' }, 'a blank line is just its number');
  assert.deepEqual((await place(ann, 3)).body, { words: 'Line 3: “image: "shop:1.4"”' }, 'without the spaces around it');
  assert.deepEqual((await place(ann, 4)).body, { words: `Line 4: “${'x'.repeat(120)}…”` });
  assert.deepEqual((await place(ann, 5)).body, { words: 'A line no longer there' });
  for (const bad of ['0', 'abc', '-1', '1.5', '']) assert.equal((await place(ann, bad)).status, 400, `line=${bad}`);
  assert.equal((await place(ben, 1)).status, 404, 'not for someone it isn’t shared with');
  // A file that isn't text has no lines; the other places are refused for an uploaded file as before.
  const pic = (await ann('POST', '/api/files/upload?name=dot.png', null, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))).body;
  assert.equal((await ann('GET', `/api/files/${pic.id}/place?line=1`)).status, 400);
  assert.equal((await ann('GET', `/api/files/${f.id}/place?slide=x`)).status, 400);
});

test('searching for words inside a text file says which line they’re on, to open it there', async () => {
  const ann = client(); assert.equal((await ann('POST', '/api/auth/login', { username: 'ann@acme.com', password: 'password123' })).status, 200);
  const up = async (name, text) => (await ann('POST', `/api/files/upload?name=${name}`, null, Buffer.from(text))).body;
  await up('service.yaml', 'name: shop\n\nspec:\n  quokkareplicas: 3\n');
  await up('quokkareplicas-notes.txt', 'nothing inside');
  await up('table.csv', 'a,b\nquokkareplicas,1\n');
  await up('readme.md', '# Title\n\nquokkareplicas here\n');
  const { indexPending } = await import('../src/search.js');
  while (await indexPending()) { /* until everything is indexed */ }
  const found = (await ann('GET', '/api/files?view=search&q=quokkareplicas')).body;
  const by = Object.fromEntries(found.map((f) => [f.name, f]));
  assert.deepEqual(Object.keys(by).sort(), ['quokkareplicas-notes.txt', 'readme.md', 'service.yaml', 'table.csv']);
  assert.deepEqual([by['service.yaml'].place_line, by['service.yaml'].place_words], [4, 'Line 4']);
  assert.equal(by['quokkareplicas-notes.txt'].place_line, undefined, 'found by its name: opened at the top');
  assert.equal(by['table.csv'].place_line, undefined, 'shown as a table, not as lines');
  assert.equal(by['readme.md'].place_line, undefined, 'shown formatted, not as lines');
});
