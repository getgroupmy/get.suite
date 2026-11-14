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
  await until(async () => JSON.parse((await chartNode()).attrs.data).series[0].values.join() === '50,100', 15000);
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
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
