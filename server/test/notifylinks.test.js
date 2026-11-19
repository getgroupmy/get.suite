// The links the server puts in notifications, emails and the like (link: `/drive/shared`, …) lead to pages
// the web app has: an address it doesn't know quietly opens Drive instead, so a typo would go unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const src = path.join(here, '../src');
const web = path.join(here, '../../web/src');
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []));

test('every in-app link the server writes leads to a page the web app has', () => {
  // The app's pages (App.jsx), and Drive's views (Drive.jsx).
  const app = fs.readFileSync(path.join(web, 'App.jsx'), 'utf8');
  const tops = new Set([...app.matchAll(/path="\/([a-z-]+)/g)].map((m) => m[1]));
  const drive = fs.readFileSync(path.join(web, 'apps/drive/Drive.jsx'), 'utf8');
  const driveViews = new Set(JSON.parse(drive.match(/if \((\[[^\]]*'sharedbyme'[^\]]*\])\.includes\(parts\[0\]\)\)/)[1].replace(/'/g, '"')));
  assert.ok(tops.has('drive') && tops.has('tasks') && driveViews.has('shared'), 'routes read');
  const found = [];
  for (const f of files(src)) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\blink: *[`'](\/[a-z][a-z-]*)(\/[a-z][a-z-]*)?/g)) found.push({ file: path.relative(src, f), top: m[1].slice(1), sub: m[2]?.slice(1) });
  }
  assert.ok(found.length > 50, `links found: ${found.length}`);
  const bad = found.filter((x) => !tops.has(x.top) || (x.top === 'drive' && x.sub && !driveViews.has(x.sub) && x.sub !== 'folder'));
  assert.deepEqual(bad.map((x) => `${x.file}: /${x.top}${x.sub ? `/${x.sub}` : ''}`), []);
});
