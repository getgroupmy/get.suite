// Also Docs → Insert table from a spreadsheet (a sheet's cells as a table to put in a document).
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

test('a spreadsheet’s cells as a table for a document: values as shown, bold kept, hidden rows left out, a range', async () => {
  const sheet = { sheets: [
    { name: 'Costs', cells: { A1: 'Item', B1: 'Cost', A2: 'Chairs', B2: '1200', A3: 'Secret', B3: '9', A4: 'Total', B4: '=B2+B3' },
      formats: { A1: { b: true }, B1: { b: true }, B2: { num: 'currency', cur: 'USD', dp: 2 }, B4: { num: 'currency', cur: 'USD', dp: 2 } }, hide: { rows: [2] } },
    { name: 'Empty', cells: {} },
  ] };
  const f = (await ann('POST', '/api/files/new', { name: 'Budget', kind: 'sheet', content: sheet })).body;
  const r = await ann('GET', `/api/files/${f.id}/table`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.sheets.map((s) => s.name), ['Costs', 'Empty']);
  assert.equal(r.body.range, 'A1:B4');
  assert.deepEqual(r.body.rows.map((row) => row.map((c) => c.text)), [['Item', 'Cost'], ['Chairs', '$1,200.00'], ['Total', '$1,209.00']]);
  assert.deepEqual(r.body.rows[0].map((c) => c.bold), [true, true]);
  // A range; another sheet; ranges not understood or too big; not a spreadsheet; someone without access.
  const part = (await ann('GET', `/api/files/${f.id}/table?range=${encodeURIComponent('b4:a4')}`)).body;
  assert.deepEqual([part.range, part.rows.map((row) => row.map((c) => c.text))], ['A4:B4', [['Total', '$1,209.00']]]);
  assert.match((await ann('GET', `/api/files/${f.id}/table?sheet=1`)).body.error, /empty/);
  assert.match((await ann('GET', `/api/files/${f.id}/table?range=nonsense`)).body.error, /like A1:D10/);
  assert.match((await ann('GET', `/api/files/${f.id}/table?range=A1:Z200`)).body.error, /too many cells/);
  // For a slide: no more than 20 rows and 10 columns.
  const wide = (await ann('POST', '/api/files/new', { name: 'Wide', kind: 'sheet', content: { sheets: [{ name: 'S', cells: { A1: 'a', L1: 'z', A30: 'end' } }] } })).body;
  assert.match((await ann('GET', `/api/files/${wide.id}/table?for=slides`)).body.error, /30 rows and 12 columns: a table here takes up to 20 rows and 10 columns/);
  assert.equal((await ann('GET', `/api/files/${wide.id}/table?for=slides&range=A1:J20`)).body.rows.length, 20);
  assert.equal((await ann('GET', `/api/files/${wide.id}/table`)).body.rows.length, 30, 'a document’s table can be bigger');
  const d = (await ann('POST', '/api/files/new', { name: 'D', kind: 'doc' })).body;
  assert.equal((await ann('GET', `/api/files/${d.id}/table`)).status, 400);
  assert.equal((await ben('GET', `/api/files/${f.id}/table`)).status, 404);
});

test('a document’s table opened in Sheets: numbers read as typed, the header bold and kept in view, codes and formulas kept as text', async () => {
  const d = (await ann('POST', '/api/files/new', { name: 'Plan', kind: 'doc' })).body;
  const r = await ann('POST', `/api/files/${d.id}/table-to-sheet`, { header: true, rows: [['Item', 'Cost', 'Share', 'Code'], ['Chairs', '$1,200.00', '12%', '007'], ['Desks', '350', '', '=cmd()']] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.kind], ['Plan (table)', 'sheet']);
  const sh = (await ann('GET', `/api/files/${r.body.id}/content`)).body.content.sheets[0];
  assert.deepEqual(sh.cells, { A1: 'Item', B1: 'Cost', C1: 'Share', D1: 'Code', A2: 'Chairs', B2: '1200', C2: '0.12', D2: "'007", A3: 'Desks', B3: '350', D3: "'=cmd()" });
  assert.deepEqual([sh.formats.A1, sh.formats.B2, sh.formats.C2], [{ b: true }, { num: 'currency', cur: 'USD', dp: 2 }, { num: 'percent', dp: 0 }]);
  assert.deepEqual(sh.frozen, { rows: 1, cols: 0 });
  // Shown as it was written (its worked-out value and format).
  const t = (await ann('GET', `/api/files/${r.body.id}/table`)).body.rows.map((row) => row.map((c) => c.text));
  assert.deepEqual(t[1], ['Chairs', '$1,200.00', '12%', '007']);
  // Refused: no rows, too big, not text; a spreadsheet; someone without access.
  assert.equal((await ann('POST', `/api/files/${d.id}/table-to-sheet`, { rows: [] })).status, 400);
  assert.equal((await ann('POST', `/api/files/${d.id}/table-to-sheet`, { rows: [Array(101).fill('x')] })).status, 400);
  assert.equal((await ann('POST', `/api/files/${d.id}/table-to-sheet`, { rows: [[{ evil: 1 }]] })).status, 400);
  assert.equal((await ann('POST', `/api/files/${r.body.id}/table-to-sheet`, { rows: [['a']] })).status, 400);
  // A table on a slide too, named after the presentation.
  const deck = (await ann('POST', '/api/files/new', { name: 'Pitch', kind: 'slides' })).body;
  const fromSlide = await ann('POST', `/api/files/${deck.id}/table-to-sheet`, { header: false, rows: [['North', '1,234'], ['South', '99']] });
  assert.equal(fromSlide.status, 201);
  assert.equal(fromSlide.body.name, 'Pitch (table)');
  const ss = (await ann('GET', `/api/files/${fromSlide.body.id}/content`)).body.content.sheets[0];
  assert.deepEqual([ss.cells.B1, ss.formats.B1, ss.frozen], ['1234', { num: 'number', dp: 0 }, undefined]);
  assert.equal((await ben('POST', `/api/files/${d.id}/table-to-sheet`, { rows: [['a']] })).status, 404);
});

test('Drive → Open tables in Sheets: a document’s tables, a Word file’s and a web page’s, a sheet each', async () => {
  const T = (rows, head = true) => ({ type: 'table', content: rows.map((r, i) => ({ type: 'tableRow', content: r.map((t) => ({ type: head && !i ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph', ...(t && { content: [{ type: 'text', text: t }] }) }] })) })) });
  const d = (await ann('POST', '/api/files/new', { name: 'Quarterly', kind: 'doc', content: { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Intro' }] },
    T([['Region', 'Sales'], ['North', '$1,200.00']]),
    T([['Only', 'one row']]),
    T([['Item', 'Qty'], ['Bolts', '1,000']], false),
  ] } })).body;
  const r = await ann('POST', `/api/files/${d.id}/tables-to-sheet`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.kind, r.body.tables], ['Quarterly (tables)', 'sheet', 2]);
  const book = (await ann('GET', `/api/files/${r.body.id}/content`)).body.content.sheets;
  assert.deepEqual(book.map((s) => s.name), ['Table 1', 'Table 2']);
  assert.deepEqual([book[0].cells.B2, book[0].formats.A1, book[1].cells.B2], ['1200', { b: true }, '1000']);
  // A Word file (made by downloading the document) and a web page, uploaded to Drive.
  const { wordFromDoc } = await import('../src/office/word.js');
  const docx = await wordFromDoc({ type: 'doc', content: [T([['Month', 'Cost'], ['Jan', '$50.00']])] }, 'Costs');
  const upW = (await ann('POST', '/api/files/upload?name=Costs.docx', null, docx)).body;
  const fromWord = await ann('POST', `/api/files/${upW.id}/tables-to-sheet`, {});
  assert.equal(fromWord.status, 201, JSON.stringify(fromWord.body));
  const ws = (await ann('GET', `/api/files/${fromWord.body.id}/content`)).body.content.sheets[0];
  assert.deepEqual([fromWord.body.name, ws.cells.A2, ws.cells.B2], ['Costs (tables)', 'Jan', '50']);
  const html = Buffer.from('<html><body><h1>Prices</h1><table><tr><th>Item</th><th>Price</th></tr><tr><td>Nuts</td><td>12%</td></tr></table></body></html>');
  const up = (await ann('POST', '/api/files/upload?name=prices.html', null, html)).body;
  const fromHtml = await ann('POST', `/api/files/${up.id}/tables-to-sheet`, {});
  assert.equal(fromHtml.status, 201, JSON.stringify(fromHtml.body));
  assert.equal(fromHtml.body.name, 'prices (tables)');
  const hs = (await ann('GET', `/api/files/${fromHtml.body.id}/content`)).body.content.sheets[0];
  assert.deepEqual([hs.name, hs.cells.A2, hs.cells.B2, hs.formats.B2], ['Sheet1', 'Nuts', '0.12', { num: 'percent', dp: 0 }]);
  // No tables; a kind of file without any; someone without access.
  const plain = (await ann('POST', '/api/files/new', { name: 'Plain', kind: 'doc' })).body;
  assert.match((await ann('POST', `/api/files/${plain.id}/tables-to-sheet`, {})).body.error, /has no tables of figures/);
  const png = (await ann('POST', '/api/files/upload?name=x.png', null, PNG)).body;
  assert.match((await ann('POST', `/api/files/${png.id}/tables-to-sheet`, {})).body.error, /Only documents/);
  assert.equal((await ben('POST', `/api/files/${d.id}/tables-to-sheet`, {})).status, 404);
});

test('Drive → List contents in Sheets: a folder’s files and folders inside, a row each with where, what, whose, size, when', async () => {
  const top = (await ann('POST', '/api/files/folder', { name: 'Project X' })).body;
  const inner = (await ann('POST', '/api/files/folder', { name: 'Designs', parent_id: top.id })).body;
  await ann('POST', '/api/files/new', { kind: 'doc', name: 'Brief', parent_id: top.id });
  const up = (await ann('POST', `/api/files/upload?name=logo.png&parent=${inner.id}`, null, PNG)).body;
  assert.ok(up.id);
  const r = await ann('POST', `/api/files/${top.id}/contents-sheet`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.kind, r.body.items, r.body.more], ['Project X (contents)', 'sheet', 3, false]);
  const sh = (await ann('GET', `/api/files/${r.body.id}/content`)).body.content.sheets[0];
  const row = (n) => ['A', 'B', 'C', 'D', 'E'].map((c) => sh.cells[`${c}${n}`] ?? '');
  assert.deepEqual(row(1), ['Folder', 'Name', 'Kind', 'Owner', 'Size (KB)']);
  assert.deepEqual(row(2).slice(0, 4), ['Project X', 'Brief', 'Document', 'Ann Owner']);
  assert.deepEqual(row(3).slice(0, 3), ['Project X', 'Designs', 'Folder']);
  assert.deepEqual(row(4).slice(0, 4), ['Project X/Designs', 'logo.png', 'PNG file', 'Ann Owner']);
  assert.match(sh.cells.F2, /^\d{4}-\d\d-\d\d$/);
  // Not a folder; an empty one; someone without access.
  const empty = (await ann('POST', '/api/files/folder', { name: 'Empty' })).body;
  assert.match((await ann('POST', `/api/files/${empty.id}/contents-sheet`, {})).body.error, /empty/);
  assert.equal((await ann('POST', `/api/files/${up.id}/contents-sheet`, {})).status, 400);
  assert.equal((await ben('POST', `/api/files/${top.id}/contents-sheet`, {})).status, 404);
});
