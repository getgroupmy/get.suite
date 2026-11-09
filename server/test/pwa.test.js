import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-pwa-'));
const { createApp } = await import('../src/app.js');
const PUB = new URL('../../web/public/', import.meta.url).pathname;

test('installable app: the manifest names real icons of the right sizes', () => {
  const m = JSON.parse(fs.readFileSync(path.join(PUB, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) {
    const png = fs.readFileSync(path.join(PUB, i.src));
    assert.equal(png.subarray(1, 4).toString(), 'PNG', i.src);
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    assert.equal(`${w}x${h}`, i.sizes, i.src);
  }
  // In the phone's Share menu: files (and links) come to /share-target, which the service worker keeps on the device.
  assert.deepEqual([m.share_target.action, m.share_target.method, m.share_target.enctype, m.share_target.params.files[0].name], ['/share-target', 'POST', 'multipart/form-data', 'files']);
  const sw = fs.readFileSync(path.join(PUB, 'sw.js'), 'utf8');
  assert.match(sw, /SKIP = .*api\|dav/, 'live data is never kept by the service worker');
});

test('installable app: the service worker and manifest are served fresh, the app files for a year', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-pwa-pub-'));
  fs.cpSync(PUB, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Workspace</title>');
  fs.mkdirSync(path.join(dir, 'assets')); fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'x');
  const server = http.createServer(createApp({ publicDir: dir }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const sw = await fetch(`${base}/sw.js`);
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('content-type'), /javascript/);
    assert.equal(sw.headers.get('cache-control'), 'no-cache');
    const m = await fetch(`${base}/manifest.webmanifest`);
    assert.match(m.headers.get('content-type'), /manifest\+json/);
    assert.equal(m.headers.get('cache-control'), 'no-cache');
    assert.match((await fetch(`${base}/assets/app-abc123.js`)).headers.get('cache-control'), /immutable/);
    assert.equal((await fetch(`${base}/icons/icon-192.png`)).headers.get('content-type'), 'image/png');
    // Shared before the service worker runs: nothing is read or kept, Drive just opens.
    const fd = new FormData(); fd.append('files', new Blob(['x']), 'a.txt');
    const st = await fetch(`${base}/share-target`, { method: 'POST', body: fd, redirect: 'manual' });
    assert.deepEqual([st.status, st.headers.get('location')], [303, '/drive']);
  } finally { server.close(); }
});
