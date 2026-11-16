import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import express from 'express';
import { compressJson, gzipStatic } from '../src/compress.js';

let server, base, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gz-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'app-1234.js'), 'console.log("hello");\n'.repeat(500));
  fs.writeFileSync(path.join(dir, 'tiny.js'), 'x();');
  fs.writeFileSync(path.join(dir, 'pic.png'), Buffer.alloc(5000));
  fs.writeFileSync(path.join(os.tmpdir(), 'outside-secret.js'), 'secret'.repeat(1000));
  const app = express();
  app.use('/api', compressJson());
  app.get('/api/big', (req, res) => res.json({ files: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `Doc ${i}` })) }));
  app.get('/api/small', (req, res) => res.json({ ok: true }));
  app.post('/api/big', (req, res) => res.json({ token: 'nwt_secret', files: Array.from({ length: 500 }, (_, i) => ({ id: i })) }));
  app.use(gzipStatic(dir, (p) => (p.includes(`${path.sep}assets${path.sep}`) ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {})));
  app.use(express.static(dir));
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// Raw requests (fetch would unzip by itself and hide the headers' effect).
const raw = (method, url, headers = {}) => new Promise((ok, fail) => {
  const req = http.request(base + url, { method, headers }, (res) => { const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) })); });
  req.on('error', fail); req.end();
});
const GZ = { 'accept-encoding': 'gzip, deflate, br' };

test('API: a big GET answer is gzipped for a browser that takes it, and unzips to the same JSON', async () => {
  const r = await raw('GET', '/api/big', GZ);
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.match(r.headers.vary, /Accept-Encoding/);
  assert.match(r.headers['content-type'], /^application\/json/);
  const json = JSON.parse(zlib.gunzipSync(r.body));
  assert.equal(json.files.length, 500);
  assert.ok(r.body.length < JSON.stringify(json).length / 4, `${r.body.length} bytes`);
  assert.equal(Number(r.headers['content-length']), r.body.length);
});

test('API: small answers, clients that don’t take gzip, and POST answers (which can hold secrets) are sent as they are', async () => {
  assert.equal((await raw('GET', '/api/small', GZ)).headers['content-encoding'], undefined);
  const plain = await raw('GET', '/api/big');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(JSON.parse(plain.body).files.length, 500);
  const post = await raw('POST', '/api/big', GZ);
  assert.equal(post.headers['content-encoding'], undefined);
  assert.match(post.body.toString(), /nwt_secret/);
});

test('web app files: scripts gzipped with their caching headers; 304 when unchanged; small files, pictures and paths outside left alone', async () => {
  const r = await raw('GET', '/assets/app-1234.js', GZ);
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.match(r.headers['content-type'], /^text\/javascript/);
  assert.match(r.headers['cache-control'], /immutable/);
  assert.equal(zlib.gunzipSync(r.body).toString(), 'console.log("hello");\n'.repeat(500));
  const again = await raw('GET', '/assets/app-1234.js', { ...GZ, 'if-none-match': r.headers.etag });
  assert.equal(again.status, 304);
  const head = await raw('HEAD', '/assets/app-1234.js', GZ);
  assert.deepEqual([head.status, head.body.length, head.headers['content-encoding']], [200, 0, 'gzip']);
  // Without gzip, express.static serves it plainly.
  const plain = await raw('GET', '/assets/app-1234.js');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString().length, 'console.log("hello");\n'.length * 500);
  assert.equal((await raw('GET', '/tiny.js', GZ)).headers['content-encoding'], undefined);
  assert.equal((await raw('GET', '/pic.png', GZ)).headers['content-encoding'], undefined);
  const out = await raw('GET', '/..%2Foutside-secret.js', GZ);
  assert.notEqual(out.status, 200);
  assert.doesNotMatch(out.body.toString(), /secretsecret/, 'the file outside isn’t served (only its name echoed on the 404 page)');
  // A new version of a file (same name) is compressed afresh.
  fs.writeFileSync(path.join(dir, 'assets', 'app-1234.js'), 'console.log("changed");\n'.repeat(500));
  const t = new Date(Date.now() + 5000); fs.utimesSync(path.join(dir, 'assets', 'app-1234.js'), t, t);
  assert.match(zlib.gunzipSync((await raw('GET', '/assets/app-1234.js', GZ)).body).toString(), /changed/);
});
