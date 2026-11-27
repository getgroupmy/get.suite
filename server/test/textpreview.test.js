// Code and data files (.json, .py, .yaml…) in Drive: their preview reads the text (the first 512 KB), also for someone who
// may only view with downloading off; binary files and other kinds are refused.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-textprev-'));
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


test('a code or data file’s text for its preview', async () => {
  const ann = client();
  assert.equal((await ann('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ann Owner', local: 'ann', password: 'password123' })).status, 200);
  const benId = (await ann('POST', '/api/users', { local: 'ben', domain: 'acme.com', name: 'Ben Member', password: 'password123' })).body.id;
  const ben = client(); assert.equal((await ben('POST', '/api/auth/login', { username: 'ben@acme.com', password: 'password123' })).status, 200);
  const json = (await ann('POST', '/api/files/upload?name=prices.json', null, Buffer.from('{"chair":40,"desk":"Ünïcode ✓"}'))).body;
  const r = await ann('GET', `/api/files/${json.id}/source-text`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { text: '{"chair":40,"desk":"Ünïcode ✓"}', truncated: false, size: json.size });
  const py = (await ann('POST', '/api/files/upload?name=report.py', null, Buffer.from('print("hi")\n'))).body;
  assert.equal((await ann('GET', `/api/files/${py.id}/source-text`)).body.text, 'print("hi")\n');
  const csv = (await ann('POST', '/api/files/upload?name=stock.csv', null, Buffer.from('Item,Price\nDesk,120\n'))).body;
  assert.equal((await ann('GET', `/api/files/${csv.id}/source-text`)).body.text, 'Item,Price\nDesk,120\n', 'a CSV too (shown as a table)');
  // Big: the first 512 KB, said to be cut short, with no half character at the end.
  const big = (await ann('POST', '/api/files/upload?name=big.log.sql', null, Buffer.from('é'.repeat(300 * 1024)))).body;
  const b = (await ann('GET', `/api/files/${big.id}/source-text`)).body;
  assert.equal(b.truncated, true);
  assert.equal(b.text, 'é'.repeat(256 * 1024));
  // Binary content, other kinds of file and other people's files refused.
  const bin = (await ann('POST', '/api/files/upload?name=data.json', null, Buffer.from([0x7b, 0x00, 0x01, 0x7d]))).body;
  assert.equal((await ann('GET', `/api/files/${bin.id}/source-text`)).status, 400);
  const pdf = (await ann('POST', '/api/files/upload?name=x.pdf', null, Buffer.from('%PDF-1.4'))).body;
  assert.equal((await ann('GET', `/api/files/${pdf.id}/source-text`)).status, 400);
  const doc = (await ann('POST', '/api/files/new', { kind: 'doc', name: 'D.json' })).body;
  assert.equal((await ann('GET', `/api/files/${doc.id}/source-text`)).status, 400);
  assert.equal((await ben('GET', `/api/files/${json.id}/source-text`)).status, 404);
  // A viewer may look even with downloading off (the file itself still can't be downloaded).
  assert.equal((await ann('PUT', `/api/files/${json.id}/shares`, { shares: [{ user_id: benId, role: 'viewer' }] })).status, 200);
  assert.equal((await ann('PATCH', `/api/files/${json.id}`, { no_download: true })).status, 200);
  assert.equal((await ben('GET', `/api/files/${json.id}/source-text`)).body.text, '{"chair":40,"desk":"Ünïcode ✓"}');
  const raw = await fetch(`${base}/api/files/${json.id}/raw?download`, { headers: { 'x-requested-with': 'nas-workspace' } });
  assert.notEqual(raw.status, 200);
});

test('a public link: a code file’s text and a calendar file’s events, for its preview; a password asked first; folders too', async () => {
  const ann = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'ann@acme.com', password: 'password123' })).status, 200);
  const pub = async (url, key) => { const r = await fetch(base + url, { headers: { 'x-requested-with': 'nas-workspace', ...(key && { 'x-link-key': key }) } }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const yaml = (await ann('POST', '/api/files/upload?name=config.yaml', null, Buffer.from('port: 8080\nname: shop\n'))).body;
  const link = (await ann('POST', '/api/links', { file_id: yaml.id })).body;
  assert.deepEqual((await pub(`/api/public/links/${link.token}/source-text`)).body, { text: 'port: 8080\nname: shop\n', truncated: false, size: yaml.size });
  assert.equal((await pub(`/api/public/links/${link.token}/cards`)).status, 400);
  // Downloading turned off: still shown (looking only), while the file itself can't be taken.
  assert.equal((await ann('PATCH', `/api/files/${yaml.id}`, { no_download: true })).status, 200);
  assert.equal((await pub(`/api/public/links/${link.token}/source-text`)).status, 200);
  assert.equal((await pub(`/api/public/links/${link.token}`)).body.no_download, true, 'the page knows not to offer Download for an uploaded file too');
  assert.equal((await pub(`/api/public/links/${link.token}/cards`)).status, 400);
  assert.equal((await fetch(`${base}/api/public/links/${link.token}/raw?download`)).status, 403);
  // A password: nothing until it's given.
  const ics = (await ann('POST', '/api/files/upload?name=Dates.ics', null, Buffer.from(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:a@x', 'DTSTART:20261203T100000Z', 'DTEND:20261203T110000Z', 'SUMMARY:Open day', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')))).body;
  const locked = (await ann('POST', '/api/links', { file_id: ics.id, password: 'pass-1234' })).body;
  assert.equal((await pub(`/api/public/links/${locked.token}/cards`)).status, 401);
  const key = (await (await fetch(`${base}/api/public/links/${locked.token}/unlock`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pass-1234' }) })).json()).key;
  const cards = (await pub(`/api/public/links/${locked.token}/cards`, key)).body;
  assert.deepEqual([cards.kind, cards.total, cards.events[0].title], ['calendar', 1, 'Open day']);
  // A file inside a linked folder (?item=); one outside it isn't reachable.
  const folder = (await ann('POST', '/api/files/folder', { name: 'Shop code' })).body;
  const inside = (await ann('POST', `/api/files/upload?name=app.js&parent=${folder.id}`, null, Buffer.from('console.log(1);\n'))).body;
  const fl = (await ann('POST', '/api/links', { file_id: folder.id })).body;
  assert.equal((await pub(`/api/public/links/${fl.token}/source-text?item=${inside.id}`)).body.text, 'console.log(1);\n');
  assert.equal((await pub(`/api/public/links/${fl.token}/source-text?item=${yaml.id}`)).status, 404);
  assert.equal((await pub('/api/public/links/nope/source-text')).status, 404);
});

test('a Markdown file’s preview is it formatted (headings, lists, bold), in Drive and in Chat', async () => {
  const ann = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'ann@acme.com', password: 'password123' })).status, 200);
  const md = (await ann('POST', '/api/files/upload?name=README.md', null, Buffer.from('# Shop setup\n\nSteps:\n\n- Install **the till**\n- Count the float\n'))).body;
  const p = await ann('GET', `/api/files/${md.id}/preview`);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.kind, 'doc');
  const nodes = JSON.stringify(p.body.content);
  assert.match(nodes, /"type":"heading".*"Shop setup"/);
  assert.match(nodes, /"type":"bulletList"/);
  assert.match(nodes, /"type":"bold".*?|"marks":\[\{"type":"bold"\}\],"text":"the till"/);
  // Sent in Chat: the same.
  const benId = (await ann('GET', '/api/users')).body.find((u) => u.username === 'ben@acme.com').id;
  const dm = (await ann('POST', '/api/chat/dm', { user_id: benId })).body.id;
  const m = (await ann('POST', `/api/chat/channels/${dm}/messages`, { body: 'Notes', files: [md.id] })).body;
  const fileId = m.files[0].id;
  const c = await ann('GET', `/api/chat/messages/${m.id}/files/${fileId}/preview`);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.match(JSON.stringify(c.body.content), /"Shop setup"/);
});

test('a public link to a Markdown file: shown formatted; outside pictures and unsafe links don’t come through', async () => {
  const ann = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'ann@acme.com', password: 'password123' })).status, 200);
  const md = (await ann('POST', '/api/files/upload?name=Guide.md', null, Buffer.from('# Opening hours\n\n![tracker](https://evil.example/t.png)\n\n[map](https://maps.example/shop) [bad](javascript:alert(1))\n'))).body;
  const link = (await ann('POST', '/api/links', { file_id: md.id })).body;
  const r = await fetch(`${base}/api/public/links/${link.token}/markdown`, { headers: { 'x-requested-with': 'nas-workspace' } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.kind, 'doc');
  const json = JSON.stringify(body.content);
  assert.match(json, /"type":"heading".*"Opening hours"/);
  assert.doesNotMatch(json, /evil\.example|javascript:/);
  assert.match(json, /https:\/\/maps\.example\/shop/);
  const yaml = (await ann('POST', '/api/files/upload?name=x.yaml', null, Buffer.from('a: 1'))).body;
  const yl = (await ann('POST', '/api/links', { file_id: yaml.id })).body;
  assert.equal((await fetch(`${base}/api/public/links/${yl.token}/markdown`, { headers: { 'x-requested-with': 'nas-workspace' } })).status, 400);
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
test('a public link to an uploaded Word file: previewed read-only with its pictures, for that link only', async () => {
  const ann = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'ann@acme.com', password: 'password123' })).status, 200);
  const pic = (await ann('POST', '/api/files/upload?name=logo.png', null, PNG)).body;
  const d = (await ann('POST', '/api/files/new', { kind: 'doc', name: 'Price list' })).body;
  const c = (await ann('GET', `/api/files/${d.id}/content`)).body;
  await ann('PUT', `/api/files/${d.id}/content`, { version: c.file.version, content: { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Spring prices' }] },
    { type: 'image', attrs: { fileId: pic.id, src: `/api/files/${pic.id}/raw` } }] } });
  const word = (await ann('POST', `/api/files/${d.id}/export-copy`, {})).body; // an uploaded .docx
  const link = (await ann('POST', '/api/links', { file_id: word.id })).body;
  const pub = (u) => fetch(base + u, { headers: { 'x-requested-with': 'nas-workspace' } });
  const r = await pub(`/api/public/links/${link.token}/office`);
  assert.equal(r.status, 200, await r.clone().text());
  const p = await r.json();
  assert.equal(p.kind, 'doc');
  const json = JSON.stringify(p.content);
  assert.match(json, /Spring prices/);
  const picId = /"fileId":"(p\d+)"/.exec(json)?.[1];
  assert.ok(picId, json);
  const img = await pub(`/api/public/links/${link.token}/office/${p.token}/pictures/${picId}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  // Not through another link, and not as someone signed in.
  const other = (await ann('POST', '/api/links', { file_id: pic.id })).body;
  assert.equal((await pub(`/api/public/links/${other.token}/office/${p.token}/pictures/${picId}`)).status, 404);
  assert.equal((await ann('GET', `/api/office-preview/${p.token}/pictures/${picId}`)).status, 404);
  // Downloading off: still previewed (looking only).
  assert.equal((await ann('PATCH', `/api/files/${word.id}`, { no_download: true })).status, 200);
  assert.equal((await pub(`/api/public/links/${link.token}/office`)).status, 200);
  // Not for other kinds of file.
  assert.equal((await pub(`/api/public/links/${other.token}/office`)).status, 400);
});

test('a public link to an email (.eml) or a zip: shown as Drive shows them, behind the link’s password', async () => {
  const ann = client();
  assert.equal((await ann('POST', '/api/auth/login', { username: 'ann@acme.com', password: 'password123' })).status, 200);
  const pub = (u, key) => fetch(base + u, { headers: { 'x-requested-with': 'nas-workspace', ...(key && { 'x-link-key': key }) } });
  const eml = ['From: Bob <bob@sender.example>', 'To: ann@acme.com', 'Subject: Roof quote', 'Date: Tue, 10 Nov 2026 09:00:00 +0000', 'Content-Type: text/plain; charset=utf-8', '', 'The roof costs 4,000.'].join('\r\n');
  const e = (await ann('POST', '/api/files/upload?name=Roof.eml', null, Buffer.from(eml))).body;
  const el = (await ann('POST', '/api/links', { file_id: e.id })).body;
  const ev = await (await pub(`/api/public/links/${el.token}/eml`)).json();
  assert.equal(ev.subject, 'Roof quote');
  assert.match(ev.text, /4,000/);
  const { default: JSZip } = await import('jszip');
  const z = new JSZip(); z.file('plans/floor.txt', 'first floor'); z.file('readme.txt', 'hi');
  const zf = (await ann('POST', '/api/files/upload?name=Plans.zip', null, await z.generateAsync({ type: 'nodebuffer' }))).body;
  const zl = (await ann('POST', '/api/links', { file_id: zf.id, password: 'pass-1234' })).body;
  assert.equal((await pub(`/api/public/links/${zl.token}/zip-contents`)).status, 401);
  const key = (await (await fetch(`${base}/api/public/links/${zl.token}/unlock`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pass-1234' }) })).json()).key;
  const zv = await (await pub(`/api/public/links/${zl.token}/zip-contents`, key)).json();
  assert.equal(zv.files, 2);
  assert.ok(zv.entries.some((x) => x.path === 'plans/floor.txt'));
  assert.equal((await pub(`/api/public/links/${el.token}/zip-contents`)).status, 400);
  assert.equal((await pub(`/api/public/links/${zl.token}/eml`, key)).status, 400);
});
