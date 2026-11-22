import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
  return p;
};
const page = await mk('olivia');
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
let kim;
const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
await step('setup: a colleague', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
let sheet, doc;
const chartNode = async () => { const c = (await api(page, 'GET', `/files/${doc.id}/content`)).body.content; return (c.content || []).find((n) => n.type === 'sheetChart'); };
await step('a chart from a spreadsheet goes in a document', async () => {
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Figures', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Month', B1: 'Sales', A2: 'Jan', B2: '10', A3: 'Feb', B3: '=B2*2' },
    charts: { c1: { title: 'Sales by month', type: 'line', range: 'A1:B3', x: 300, y: 20, w: 360, h: 240 } } }] } })).body;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Report' })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Our sales:');
  await page.getByRole('button', { name: 'Insert chart from Sheets' }).click();
  await page.getByRole('dialog', { name: 'Chart from a spreadsheet' }).getByRole('button', { name: /Figures/ }).click();
  await page.getByRole('dialog', { name: 'Charts in “Figures”' }).getByRole('button', { name: /Sales by month/ }).click();
  const fig = page.locator('.ProseMirror .doc-chart');
  await fig.locator('svg').first().waitFor();
  await fig.getByText('Sales by month').waitFor();
  await until(async () => { const n = await chartNode(); return n && JSON.parse(n.attrs.data).series[0].values.join() === '10,20'; }, 15000);
});
await step('Update brings in the spreadsheet\'s new figures', async () => {
  const cur = (await api(page, 'GET', `/files/${sheet.id}/content`)).body;
  cur.content.sheets[0].cells.B2 = '50';
  await api(page, 'PUT', `/files/${sheet.id}/content`, { version: cur.file.version, content: cur.content });
  await page.locator('.ProseMirror .doc-chart .slide-chart-title').click();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: '↻ Update chart' }).click();
  await until(async () => { const n = await chartNode(); return n && JSON.parse(n.attrs.data).series[0].values.join() === '50,100'; }, 15000); // (missing for a moment while the document saves)
  await page.locator('.doc-chart-bar').getByText('Up to date').waitFor();
});
await step('a reader without the spreadsheet still sees the chart; downloads have its figures', async () => {
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  await kim.goto(`${B}/docs/${doc.id}`);
  await kim.locator('.ProseMirror .doc-chart svg').first().waitFor();
  const md = await kim.evaluate(async (id) => (await fetch(`/api/files/${id}/export?format=md`)).text(), doc.id);
  if (!md.includes('**Sales by month**') || !md.includes('| Jan | 50 |')) throw new Error(md);
}, kim);
for (const format of ['docx', 'odt']) await step(`the ${format === 'docx' ? 'Word' : '.odt'} download has a real chart; reopened, it is a chart still linked to the spreadsheet`, async () => {
  const up = await page.evaluate(async ([id, f]) => {
    const bytes = await (await fetch(`/api/files/${id}/export?format=${f}`)).arrayBuffer();
    return (await fetch(`/api/files/upload?name=Report.${f}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes })).json();
  }, [doc.id, format]);
  const opened = (await api(page, 'POST', `/files/${up.id}/open-as`)).body;
  const node = ((await api(page, 'GET', `/files/${opened.id}/content`)).body.content.content || []).find((n) => n.type === 'sheetChart');
  if (!node || node.attrs.fileId !== sheet.id || node.attrs.title !== 'Sales by month' || JSON.parse(node.attrs.data).series[0].values.join() !== '50,100') throw new Error(JSON.stringify(node));
  await page.goto(`${B}/docs/${opened.id}`);
  const fig = page.locator('.ProseMirror .doc-chart');
  await fig.locator('svg').first().waitFor();
  await fig.locator('.slide-chart-title').click();
  await page.locator('.doc-chart-bar').getByText('Up to date').waitFor(); // linked: checked against the spreadsheet
});
await step('⋮ → Insert table from a spreadsheet: the cells as a table, worked-out values (B2 is 50 by now), a header row', async () => {
  const d2 = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Table report' })).body;
  await page.goto(`${B}/docs/${d2.id}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('The figures:');
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Insert table from a spreadsheet…' }).click();
  await page.getByRole('dialog', { name: 'Table from a spreadsheet' }).getByRole('button', { name: /Figures/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Table from “Figures”' });
  await dlg.getByLabel('Cells').fill('nonsense');
  await dlg.getByRole('button', { name: 'Insert table' }).click();
  await dlg.getByRole('alert').getByText(/like A1:D10/).waitFor();
  await dlg.getByLabel('Cells').fill('');
  await dlg.getByRole('button', { name: 'Insert table' }).click();
  const table = page.locator('.ProseMirror table');
  await table.waitFor();
  const rows = await table.locator('tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((c) => `${c.tagName}:${c.textContent}`).join('|')));
  if (JSON.stringify(rows) !== JSON.stringify(['TH:Month|TH:Sales', 'TD:Jan|TD:50', 'TD:Feb|TD:100'])) throw new Error(JSON.stringify(rows));
  await until(async () => JSON.stringify((await api(page, 'GET', `/files/${d2.id}/content`)).body.content).includes('"tableHeader"'), 15000);
});
await step('an AI assistant adds a spreadsheet’s cells to a document as a table (append_to_document with table_from)', async () => {
  await api(page, 'PATCH', '/orgs/current', { allow_api_tokens: true });
  const tok = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Report helper', scope: 'write', days: 30 })).body.token;
  const d3 = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Monthly report' })).body;
  const r = await page.evaluate(async ([t, doc, sh]) => (await (await fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'append_to_document', arguments: { file: `file:${doc}`, text: '## Sales', table_from: { file: `file:${sh}` } } } }) })).json()).result, [tok, d3.id, sheet.id]);
  if (r?.isError || r?.structuredContent?.table_rows !== 3) throw new Error(JSON.stringify(r));
  await page.goto(`${B}/docs/${d3.id}`);
  const table = page.locator('.ProseMirror table');
  await table.waitFor();
  await page.locator('.ProseMirror h2', { hasText: 'Sales' }).waitFor();
  const rows = await table.locator('tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((c) => `${c.tagName}:${c.textContent}`).join('|')));
  if (JSON.stringify(rows) !== JSON.stringify(['TH:Month|TH:Sales', 'TD:Jan|TD:50', 'TD:Feb|TD:100'])) throw new Error(JSON.stringify(rows));
});
await step('Table → Open in Sheets: the document’s table as a new spreadsheet, the header row bold and kept in view', async () => {
  const d4 = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Budget notes', content: { type: 'doc', content: [
    { type: 'table', content: [['Item', 'Cost'], ['Chairs', '$1,200.00'], ['Desks', '350']].map((r, i) => ({ type: 'tableRow', content: r.map((t) => ({ type: i ? 'tableCell' : 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })) })) },
  ] } })).body;
  await page.goto(`${B}/docs/${d4.id}`);
  await page.locator('.ProseMirror td', { hasText: 'Chairs' }).click();
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open in Sheets' }).click();
  await page.getByText('Made “Budget notes (table)”').waitFor();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.waitForURL(/\/sheets\//);
  await page.locator('[data-k="B2"]', { hasText: '$1,200.00' }).waitFor();
  const id = page.url().split('/').pop().split('?')[0];
  const sh = (await api(page, 'GET', `/files/${id}/content`)).body.content.sheets[0];
  if (sh.cells.B2 !== '1200' || sh.cells.B3 !== '350' || !sh.formats?.A1?.b || sh.frozen?.rows !== 1) throw new Error(JSON.stringify(sh));
});
await step('Drive ⋮ → Open tables in Sheets: every table in the document as a spreadsheet beside it', async () => {
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Budget notes', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Open tables in Sheets' }).click();
  await page.getByText('Made “Budget notes (tables)”').waitFor();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.waitForURL(/\/sheets\//);
  await page.locator('[data-k="B2"]', { hasText: '$1,200.00' }).waitFor();
  await page.locator('[data-k="A3"]', { hasText: 'Desks' }).waitFor();
});
await step('Table → Sort Z to A / A to Z by the cursor’s column: amounts by value, the heading row first, saved', async () => {
  const rowsIn = [['Item', 'Cost'], ['Chairs', '$1,200.00'], ['Desks', '350'], ['Lamps', ''], ['Pens', '$9.50']];
  const d5 = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Sorting', content: { type: 'doc', content: [
    { type: 'table', content: rowsIn.map((r, i) => ({ type: 'tableRow', content: r.map((t) => ({ type: i ? 'tableCell' : 'tableHeader', content: [{ type: 'paragraph', ...(t && { content: [{ type: 'text', text: t }] }) }] })) })) },
  ] } })).body;
  await page.goto(`${B}/docs/${d5.id}`);
  const shown = () => page.locator('.ProseMirror table tr').evaluateAll((trs) => trs.map((tr) => tr.children[0].textContent));
  await page.locator('.ProseMirror td', { hasText: '350' }).click();
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sort Z to A' }).click();
  await until(async () => JSON.stringify(await shown()) === JSON.stringify(['Item', 'Chairs', 'Desks', 'Pens', 'Lamps'])).catch(async () => { throw new Error(`by cost: ${JSON.stringify(await shown())}`); });
  await page.locator('.ProseMirror td', { hasText: 'Pens' }).click(); // (now by the Item column)
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sort Z to A' }).click();
  await until(async () => JSON.stringify(await shown()) === JSON.stringify(['Item', 'Pens', 'Lamps', 'Desks', 'Chairs'])).catch(async () => { throw new Error(`by item: ${JSON.stringify(await shown())}`); });
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sort A to Z' }).click();
  await until(async () => JSON.stringify(await shown()) === JSON.stringify(['Item', 'Chairs', 'Desks', 'Lamps', 'Pens'])).catch(async () => { throw new Error(`again by item (the cursor stayed in its cell): ${JSON.stringify(await shown())}`); });
  // Saved as sorted.
  await until(async () => {
    const t = (await api(page, 'GET', `/files/${d5.id}/content`)).body.content.content.find((n) => n.type === 'table');
    return t.content.map((r) => r.content[0].content[0].content?.[0]?.text).join() === 'Item,Chairs,Desks,Lamps,Pens';
  }, 15000);
});
await step('Table → Add a totals row: each column of figures added up, written like its numbers, in bold', async () => {
  await page.locator('.ProseMirror td', { hasText: 'Desks' }).click();
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add a totals row' }).click();
  const last = page.locator('.ProseMirror table tr').last();
  await last.locator('strong', { hasText: '$1,559.50' }).waitFor();
  if ((await last.locator('td').first().textContent()) !== 'Total') throw new Error(await last.textContent());
  await until(async () => JSON.stringify((await api(page, 'GET', `/files/${page.url().split('/').pop().split('?')[0]}/content`)).body.content).includes('$1,559.50'), 15000);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
