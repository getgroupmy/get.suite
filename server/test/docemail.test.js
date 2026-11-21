// Docs → Send as email: the document as an email's text (lists in their own look, pictures only the sender may open,
// checklists, equations and footnotes in a form an email keeps), refused for view-only files with downloading off.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-docemail-'));
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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const T = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });
const P = (...c) => ({ type: 'paragraph', content: c });
const LI = (t) => ({ type: 'listItem', content: [P(T(t))] });

let ann, ben;
test('a document as an email: its formatting, lists as they look, pictures, checklists, equations, footnotes', async () => {
  ann = client();
  assert.equal((await ann('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Ann Owner', local: 'ann', password: 'password123' })).status, 200);
  assert.equal((await ann('POST', '/api/users', { local: 'ben', domain: 'acme.com', name: 'Ben Member', password: 'password123' })).status, 201);
  ben = client(); assert.equal((await ben('POST', '/api/auth/login', { username: 'ben@acme.com', password: 'password123' })).status, 200);
  const picId = (await ann('POST', '/api/files/upload?name=logo.png', null, PNG)).body.id;
  assert.ok(picId);
  const content = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [T('Weekly update')] },
    P(T('Read the '), T('plan', [{ type: 'link', attrs: { href: 'https://example.com/plan' } }]), T(' first'), { type: 'footnote', attrs: { note: 'Updated Monday' } }, T('.')),
    { type: 'tableOfContents' },
    { type: 'orderedList', attrs: { start: 1, listStyle: 'lower-roman' }, content: [LI('Budget'), LI('Hiring')] },
    { type: 'bulletList', attrs: { bullet: 'check' }, content: [LI('Minutes sent')] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [P(T('Book room'))] }, { type: 'taskItem', attrs: { checked: false }, content: [P(T('Order lunch'))] }] },
    P({ type: 'math', attrs: { latex: 'E=mc^2' } }),
    P({ type: 'image', attrs: { fileId: picId, src: `/api/files/${picId}/raw` } }),
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [P(T('Item'))] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [P(T('Chairs'))] }] }] },
  ] };
  const doc = (await ann('POST', '/api/files/new', { name: 'Weekly update', kind: 'doc', content })).body;
  const r = await ann('GET', `/api/files/${doc.id}/email-body`);
  assert.equal(r.status, 200);
  assert.equal(r.body.subject, 'Weekly update');
  const h = r.body.html;
  assert.match(h, /^<p><strong><span style="font-size: 24px">Weekly update<\/span><\/strong><\/p>/, 'a title as Huge bold text (Mail has no headings)');
  assert.match(h, /<a href="https:\/\/example\.com\/plan">plan<\/a> first<sup>1<\/sup>\./);
  assert.match(h, /<ol style="list-style-type: lower-roman"><li><p>Budget<\/p><\/li>/);
  assert.match(h, /<ul style='list-style-type: "✓ "'><li><p>Minutes sent/);
  assert.match(h, /<p>☒ Book room<\/p><p>☐ Order lunch<\/p>/);
  assert.match(h, /<p>E=mc\^2<\/p>/, 'an equation as its LaTeX');
  assert.ok(h.includes(`<p>E=mc^2</p><img src="/api/files/${picId}/raw" alt=""/><table>`), 'the picture by its Drive address, on its own');
  assert.match(h, /<table><tr><th><p>Item<\/p><\/th><\/tr><tr><td><p>Chairs<\/p><\/td><\/tr><\/table>/);
  assert.match(h, /<hr\/><p><sup>1<\/sup> Updated Monday<\/p>$/, 'footnotes at the end');
  assert.doesNotMatch(h, /Contents|class=|epub:|<math/);

  // Ben, who can see the document but not the picture: the picture left out.
  const benId = (await ben('GET', '/api/auth/me')).body.user.id;
  assert.equal((await ann('PUT', `/api/files/${doc.id}/shares`, { shares: [{ user_id: benId, role: 'viewer' }] })).status, 200);
  const b = await ben('GET', `/api/files/${doc.id}/email-body`);
  assert.equal(b.status, 200);
  assert.ok(!b.body.html.includes('<img'));
  assert.match(b.body.html, /Budget/);
  // Downloading turned off: not for viewers.
  assert.equal((await ann('PATCH', `/api/files/${doc.id}`, { no_download: true })).status, 200);
  assert.equal((await ben('GET', `/api/files/${doc.id}/email-body`)).status, 403);
  assert.equal((await ann('GET', `/api/files/${doc.id}/email-body`)).status, 200);
  // Not a document; not someone else's.
  const sheet = (await ann('POST', '/api/files/new', { name: 'S', kind: 'sheet' })).body;
  assert.equal((await ann('GET', `/api/files/${sheet.id}/email-body`)).status, 400);
  assert.equal((await ben('GET', `/api/files/${sheet.id}/email-body`)).status, 404);
});

test('a presentation as an email: a heading a slide, its points as lists, no speaker notes or skipped slides', async () => {
  const deck = { theme: 'light', slides: [
    { id: 'a', items: [{ id: 't', type: 'text', role: 'title', text: 'Q3 review' }, { id: 's', type: 'text', role: 'subtitle', text: 'Sales team' }] },
    { id: 'b', notes: 'Say the secret number', items: [{ id: 't', type: 'text', role: 'title', text: 'Wins' }, { id: 'p', type: 'text', role: 'body', list: 'upper-alpha', text: 'Two new clients\n\tAcme\nRecord month' }] },
    { id: 'c', skip: true, items: [{ id: 't', type: 'text', role: 'title', text: 'Hidden slide' }] },
  ] };
  const f = (await ann('POST', '/api/files/new', { name: 'Q3 review', kind: 'slides', content: deck })).body;
  const r = await ann('GET', `/api/files/${f.id}/email-body`);
  assert.equal(r.status, 200);
  assert.equal(r.body.subject, 'Q3 review');
  const h = r.body.html;
  assert.match(h, /^<p>Sales team<\/p><p><strong><span style="font-size: 24px">Wins<\/span><\/strong><\/p><ol style="list-style-type: upper-alpha"><li><p>Two new clients<\/p><ol style="list-style-type: upper-alpha"><li><p>Acme<\/p><\/li><\/ol><\/li><li><p>Record month<\/p><\/li><\/ol>$/);
  assert.doesNotMatch(h, /secret|Hidden/);
});
