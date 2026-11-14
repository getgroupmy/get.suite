import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
});
let form, v;
const qs = async () => (await api(page, 'GET', `/forms/${form.id}`)).body.questions;
let doc, url, anon;
await step('the owner publishes a document from its menu', async () => {
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Price list' })).body;
  const c = (await api(page, 'GET', `/files/${doc.id}/content`)).body;
  await api(page, 'PUT', `/files/${doc.id}/content`, { version: c.file.version, content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Prices 2027' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Widgets: 10 each' }] }] } });
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Publish to the web…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Publish to the web' });
  await dlg.getByRole('button', { name: 'Publish' }).click();
  url = await dlg.getByLabel('Published address').inputValue();
  if (!/\/pub\/[\w-]{24}$/.test(url)) throw new Error(url);
  await dlg.getByRole('button', { name: 'Close' }).last().click();
});
await step('anyone with the address reads it, without signing in', async () => {
  const ctx = await browser.newContext(); anon = await ctx.newPage();
  anon.on('pageerror', (e) => errors.push(`anon: ${e.message}`));
  await anon.goto(url);
  await anon.getByRole('heading', { name: 'Prices 2027' }).waitFor();
  await anon.getByText('Widgets: 10 each').waitFor();
  await anon.getByText(/Published by Acme Trading/).waitFor();
});
await step('a spreadsheet shows worked-out values; a presentation its slides, without speaker notes', async () => {
  const sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Rates', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Hours', B1: '8', A2: 'Total', B2: '=B1*25' } }] } })).body;
  const sp = (await api(page, 'PUT', `/publish/${sheet.id}`, { on: true })).body.path;
  await anon.goto(`${B}${sp}`);
  await anon.locator('td[data-k="B2"]', { hasText: '200' }).waitFor();
  const deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Intro' })).body;
  const c = (await api(page, 'GET', `/files/${deck.id}/content`)).body;
  await api(page, 'PUT', `/files/${deck.id}/content`, { version: c.file.version, content: { ...c.content, slides: [{ id: 'a', items: [{ id: 't', type: 'text', text: 'Welcome to Acme', x: 10, y: 10, w: 80, h: 20, size: 40 }], notes: 'say hi' }] } });
  const dp = (await api(page, 'PUT', `/publish/${deck.id}`, { on: true })).body.path;
  await anon.goto(`${B}${dp}`);
  await anon.getByRole('listitem', { name: 'Slide 1' }).getByText('Welcome to Acme').waitFor();
  if (await anon.getByText('say hi').count()) throw new Error('notes shown');
});
await step('Stop publishing: the address shows nothing any more', async () => {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Publish to the web…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Publish to the web' });
  await dlg.getByText(/Opened 1 time/).waitFor();
  await dlg.getByRole('button', { name: 'Stop publishing' }).click();
  await dlg.getByRole('button', { name: 'Publish' }).waitFor();
  await anon.goto(url);
  await anon.getByText(/Nothing is published at this address/).waitFor();
});
await step('admins see what is published, stop it, and can turn publishing off', async () => {
  const again = (await api(page, 'PUT', `/publish/${doc.id}`, { on: true })).body.path;
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Company settings' }).or(page.getByRole('button', { name: 'Company settings' })).first().click();
  const list = page.getByRole('region', { name: 'Published to the web' });
  await list.getByText('Price list').waitFor();
  await list.getByRole('button', { name: 'Stop publishing Price list' }).click();
  await page.getByText('“Price list” is no longer published').waitFor();
  await anon.goto(`${B}${again}`);
  await anon.getByText(/Nothing is published at this address/).waitFor();
  await page.getByLabel(/Let people publish documents, spreadsheets and presentations to the web/).uncheck();
  await page.getByText('Publishing to the web is off: published pages no longer show').waitFor();
  if ((await api(page, 'PUT', `/publish/${doc.id}`, { on: true })).status !== 403) throw new Error('could still publish');
  await page.getByLabel(/Let people publish documents, spreadsheets and presentations to the web/).check();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
