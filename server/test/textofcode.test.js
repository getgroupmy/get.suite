// Search reads code and data files (the same list the viewer shows as text): Go, Ruby, subtitles, TOML… and in code,
// < and > are signs, not tags, so the words between them are kept; HTML and XML still lose their tags.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-textofcode-'));
process.env.DATA_DIR = dir;
const { textOf } = await import('../src/search.js');
const { FILES_DIR } = await import('../src/db.js');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const put = (name, text, mime = 'application/octet-stream') => {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  const storage = `t-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(path.join(FILES_DIR, storage), text);
  return { kind: 'file', name, mime, storage, size: Buffer.byteLength(text) };
};

test('code and data files beyond the old list are read', async () => {
  assert.match(await textOf(put('main.go', 'package main\nfunc invoiceTotal() {}\n')), /invoiceTotal/);
  assert.match(await textOf(put('report.rb', 'def quarterly_report; end\n')), /quarterly_report/);
  assert.match(await textOf(put('talk.srt', '1\n00:00:01,000 --> 00:00:03,000\nWelcome to the harvest festival\n')), /harvest festival/);
  assert.match(await textOf(put('app.toml', 'title = "Warehouse"\n')), /Warehouse/);
  assert.match(await textOf(put('Widget.tsx', 'export const Basket = () => null;\n')), /Basket/);
});

test('in code, the words between < and > are kept; markup loses its tags', async () => {
  const py = await textOf(put('check.py', 'if stock < reorder_level and price > 0:\n    order_more()\n', 'text/x-python'));
  assert.match(py, /reorder_level and price/);
  const js = await textOf(put('a.js', 'if (a < limit && b > 0) notifyWarehouse();\n', 'application/javascript'));
  assert.match(js, /limit && b/);
  const html = await textOf(put('page.html', '<p class="x">Opening <b>hours</b></p>', 'text/html'));
  assert.doesNotMatch(html, /class=|<b>/);
  assert.match(html, /Opening\s+hours/);
  const xml = await textOf(put('feed.xml', '<item><title>Spring sale</title></item>', 'application/xml'));
  assert.doesNotMatch(xml, /<title>/);
  assert.match(xml, /Spring sale/);
});

test('files usually named without an extension are read: Dockerfile, Makefile, LICENSE, README', async () => {
  assert.match(await textOf(put('Dockerfile', 'FROM node:22\nRUN npm ci --omit=dev\n')), /omit=dev/);
  assert.match(await textOf(put('Makefile', 'build:\n\tgo build ./cmd/ledger\n')), /cmd\/ledger/);
  assert.match(await textOf(put('LICENSE', 'Permission is hereby granted, free of charge')), /hereby granted/);
  assert.equal(await textOf(put('mylicense', 'not looked at')), '', 'only the usual names, whole');
});

test('other binary files are still not read as text', async () => {
  assert.equal(await textOf(put('photo.raw', 'not text')), '');
});
