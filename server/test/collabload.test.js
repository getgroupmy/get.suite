// Opening a co-edited file: the saved shared form is used while its JSON is the one it was saved with (no second
// build to compare, which takes seconds for a big spreadsheet); a JSON change made elsewhere still wins.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as Y from 'yjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-collabload-'));
process.env.DATA_DIR = dir;
let server, base, collab, cd, q;
before(async () => {
  const { createApp } = await import('../src/app.js');
  collab = await import('../src/collab.js');
  cd = await import('../src/collabdoc.js');
  ({ q } = await import('../src/db.js'));
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
let cookie = '';
const api = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
};
const cellsOf = (doc) => cd.jsonFromSheetDoc(doc).sheets[0].cells;

test('the saved shared form is used while the JSON is unchanged; a change made elsewhere wins; old files get a fingerprint', async () => {
  assert.equal((await api('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  const f = (await api('POST', '/api/files/new', { kind: 'sheet', name: 'Budget', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Rent', B1: '900' } }] } })).body;
  // A saved shared form whose JSON matches (as co-editing saves them): it's what is opened.
  const shared = cd.sheetDocFromJson({ sheets: [{ name: 'Sheet1', cells: { A1: 'Rent', B1: '900' } }] });
  const { content } = q('SELECT content FROM files WHERE id = ?').get(f.id);
  q('UPDATE files SET ydoc = ?, ydoc_of = ? WHERE id = ?').run(Buffer.from(Y.encodeStateAsUpdate(shared)), collab.fingerprint(content), f.id);
  const opened = collab.loadDoc(f.id, 'sheet');
  assert.deepEqual(cellsOf(opened), { A1: 'Rent', B1: '900' });
  assert.equal(Y.encodeStateAsUpdate(opened).length, Y.encodeStateAsUpdate(shared).length, 'the saved form itself, not a rebuilt one');
  // The JSON changed outside co-editing (a version restored): the fingerprint no longer matches, and the JSON wins.
  const v = (await api('GET', `/api/files/${f.id}`)).body.version;
  assert.equal((await api('PUT', `/api/files/${f.id}/content`, { version: v, content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Rent', B1: '950' } }] } })).status, 200);
  const after1 = q('SELECT ydoc, ydoc_of, content FROM files WHERE id = ?').get(f.id);
  if (after1.ydoc) assert.notEqual(after1.ydoc_of, collab.fingerprint(after1.content));
  assert.equal(cellsOf(collab.loadDoc(f.id, 'sheet')).B1, '950');
  // A file saved before fingerprints: compared once the old way, then fingerprinted.
  const now = q('SELECT content FROM files WHERE id = ?').get(f.id).content;
  q('UPDATE files SET ydoc = ?, ydoc_of = NULL WHERE id = ?').run(Buffer.from(Y.encodeStateAsUpdate(cd.sheetDocFromJson(JSON.parse(now)))), f.id);
  assert.equal(cellsOf(collab.loadDoc(f.id, 'sheet')).B1, '950');
  assert.equal(q('SELECT ydoc_of FROM files WHERE id = ?').get(f.id).ydoc_of, collab.fingerprint(now));
  // A stale shared form with an old file (no fingerprint, JSON different): rebuilt from the JSON, not fingerprinted.
  q('UPDATE files SET ydoc = ?, ydoc_of = NULL WHERE id = ?').run(Buffer.from(Y.encodeStateAsUpdate(shared)), f.id);
  assert.equal(cellsOf(collab.loadDoc(f.id, 'sheet')).B1, '950');
  // Rebuilt from the JSON: kept with the JSON's fingerprint for next time, without counting as an edit.
  const kept = q('SELECT ydoc, ydoc_of, content, version FROM files WHERE id = ?').get(f.id);
  assert.equal(kept.ydoc_of, collab.fingerprint(kept.content));
  assert.deepEqual(cellsOf((() => { const d = new Y.Doc(); Y.applyUpdate(d, new Uint8Array(kept.ydoc)); return d; })()), { A1: 'Rent', B1: '950' });
  assert.equal(kept.version, (await api('GET', `/api/files/${f.id}`)).body.version);
  // A file never co-edited: built once, then kept.
  const g = (await api('POST', '/api/files/new', { kind: 'doc', name: 'Notes', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] } })).body;
  const v0 = (await api('GET', `/api/files/${g.id}`)).body.version;
  collab.loadDoc(g.id, 'doc');
  const gRow = q('SELECT ydoc, ydoc_of, content, version FROM files WHERE id = ?').get(g.id);
  assert.ok(gRow.ydoc && gRow.ydoc_of === collab.fingerprint(gRow.content));
  assert.equal(gRow.version, v0);
});
