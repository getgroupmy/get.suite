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
let sheet, deck;
const deckNow = async () => (await api(page, 'GET', `/files/${deck.id}/content`)).body.content;
const chartItem = async () => (await deckNow()).slides[0].items.find((x) => x.type === 'chart');
await step('a chart from a spreadsheet goes on a slide', async () => {
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Figures', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Month', B1: 'Sales', A2: 'Jan', B2: '10', A3: 'Feb', B3: '=B2*2' },
    charts: { c1: { title: 'Sales by month', type: 'column', range: 'A1:B3', x: 300, y: 20, w: 360, h: 240 } } }] } })).body;
  deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Review' })).body;
  await page.goto(`${B}/slides/${deck.id}`);
  await page.getByRole('button', { name: 'Chart', exact: true }).click();
  await page.getByRole('dialog', { name: 'Chart from a spreadsheet' }).getByRole('button', { name: /Figures/ }).click();
  await page.getByRole('dialog', { name: 'Charts in “Figures”' }).getByRole('button', { name: /Sales by month/ }).click();
  const box = page.locator('.slide-stage .slide-item.chart');
  await box.locator('svg').first().waitFor();
  await box.getByText('Sales by month').waitFor();
  await until(async () => { const c = await chartItem(); return c && JSON.stringify(c.data.series) === JSON.stringify([{ name: 'Sales', values: [10, 20] }]); });
  await page.getByText('Up to date').waitFor();
});
await step('after the spreadsheet changes, Update brings in its new figures', async () => {
  const cur = (await api(page, 'GET', `/files/${sheet.id}/content`)).body;
  cur.content.sheets[0].cells.B2 = '50';
  const r = await api(page, 'PUT', `/files/${sheet.id}/content`, { version: cur.file.version, content: cur.content });
  if (r.status !== 200) throw new Error(JSON.stringify(r).slice(0, 200));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: '↻ Update chart' }).click();
  await until(async () => JSON.stringify((await chartItem()).data.series[0].values) === '[50,100]');
  await page.getByText('Up to date').waitFor();
});
await step('someone who can see the presentation but not the spreadsheet still sees the chart', async () => {
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  await api(page, 'PUT', `/files/${deck.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await kim.goto(`${B}/slides/${deck.id}`);
  const box = kim.locator('.slide-stage .slide-item.chart');
  await box.locator('svg').first().waitFor();
  await box.click();
  await kim.getByText('Spreadsheet not shared with you').waitFor();
  if (await kim.getByRole('button', { name: '↻ Update chart' }).count()) throw new Error('offered an update');
}, kim);
await step('the PowerPoint download has a chart in it', async () => {
  const ok = await page.evaluate(async (id) => { const r = await fetch(`/api/files/${id}/export?format=pptx`); const b = new Uint8Array(await r.arrayBuffer()); return r.status + ':' + new TextDecoder().decode(b).includes('ppt/charts/chart'); }, deck.id);
  if (ok !== '200:true') throw new Error(ok);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
