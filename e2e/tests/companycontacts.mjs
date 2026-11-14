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
await step('share a contact with the company', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await page.goto(`${B}/contacts`);
  await page.getByRole('button', { name: /New contact/ }).click();
  const m = page.getByRole('dialog');
  await m.getByLabel('Name').fill('Globex Supplies');
  await m.getByLabel('Email', { exact: true }).fill('orders@globex.example.com');
  await m.getByLabel('Share with everyone at Acme Trading').check();
  await m.getByRole('button', { name: 'Save' }).click();
  await m.waitFor({ state: 'detached' });
  await page.locator('tbody tr', { hasText: 'Globex Supplies' }).getByText('Shared with company').waitFor();
  await page.getByRole('tab', { name: 'Company' }).click();
  await page.locator('tbody tr', { hasText: 'Globex Supplies' }).getByText('Added by you').waitFor();
});
await step('a colleague sees it read-only and finds it when writing mail', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/contacts`);
  await kim.getByRole('tab', { name: 'Company' }).click();
  const row = kim.locator('tbody tr', { hasText: 'Globex Supplies' });
  await row.getByText('Added by Olivia Owner').waitFor();
  if (await row.getByRole('button', { name: 'Edit Globex Supplies' }).count()) throw new Error('editable by kim');
  const s = await api(kim, 'GET', '/contacts/suggest?q=globex');
  if (!JSON.stringify(s.body).includes('orders@globex.example.com')) throw new Error('suggest ' + JSON.stringify(s.body));
  const id = (await api(kim, 'GET', '/contacts?scope=company')).body[0].id;
  if ((await api(kim, 'PATCH', `/contacts/${id}`, { name: 'x' })).status !== 404) throw new Error('kim patched');
}, kim);
await step('unsharing takes it off the Company tab', async () => {
  await page.getByRole('button', { name: 'Edit Globex Supplies' }).click();
  const m = page.getByRole('dialog');
  await m.getByLabel('Share with everyone at Acme Trading').uncheck();
  await m.getByRole('button', { name: 'Save' }).click();
  await m.waitFor({ state: 'detached' });
  await page.getByText('No company contacts yet').waitFor();
  await kim.reload(); await kim.getByRole('tab', { name: 'Company' }).click();
  await kim.getByText('No company contacts yet').waitFor();
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
