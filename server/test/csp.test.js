// The app's page carries a Content-Security-Policy that only lets the app's own scripts run; what browsers
// report it blocked goes to the server log.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-csp-'));
process.env.DATA_DIR = path.join(dir, 'data');
const pub = path.join(dir, 'public');
fs.mkdirSync(pub, { recursive: true });
fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>Workspace</title>');
let server, base;
before(async () => {
  const { createApp } = await import('../src/app.js');
  server = http.createServer(createApp({ publicDir: pub }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('the app page: only its own scripts, no plugins, not framed by other sites; its live connection allowed', async () => {
  const r = await fetch(`${base}/drive`);
  const csp = r.headers.get('content-security-policy');
  const d = Object.fromEntries(csp.split(';').map((x) => x.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
  assert.equal(d['script-src'], "'self'");
  assert.equal(d['object-src'], "'none'");
  assert.equal(d['frame-ancestors'], "'self'");
  assert.equal(d['base-uri'], "'self'");
  assert.match(d['connect-src'], new RegExp(`'self' ws://127\\.0\\.0\\.1:\\d+ wss://127\\.0\\.0\\.1:\\d+`));
  assert.equal(d['report-uri'], '/csp-report');
  // Pages made to be embedded elsewhere can be.
  assert.equal(Object.fromEntries((await fetch(`${base}/pub/abc123`)).headers.get('content-security-policy').split(';').map((x) => x.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]))['frame-ancestors'], '*');
  // A forged Host can't add a source.
  const evil = await new Promise((ok) => http.get(`${base}/drive`, { headers: { host: "x.com; script-src *" } }, (res) => { res.resume(); ok(res.headers['content-security-policy']); }));
  assert.match(evil, /script-src 'self'(;|$)/);
  assert.doesNotMatch(evil, /script-src \*/);
});

test('violation reports are taken (and logged), without signing in', async () => {
  const logged = [];
  const warn = console.warn; console.warn = (...a) => logged.push(a.join(' '));
  try {
    const r = await fetch(`${base}/csp-report`, { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body: JSON.stringify({ 'csp-report': { 'document-uri': `${base}/mail?x=secret`, 'violated-directive': 'script-src-attr', 'blocked-uri': 'inline' } }) });
    assert.equal(r.status, 204);
  } finally { console.warn = warn; }
  assert.match(logged.join('\n'), /\[csp\] blocked script-src-attr inline on http:\/\/127\.0\.0\.1:\d+\/mail$/m, 'the page, without its query');
});
