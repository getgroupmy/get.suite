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
let token;
await step('a file request', async () => {
  const folderId = (await api(page, 'POST', '/files/folder', { name: 'Receipts' })).body.id;
  token = (await api(page, 'POST', '/links', { file_id: folderId, mode: 'upload' })).body.token;
  await page.goto(`${B}/drive`);
});
await step('three files from one person: one entry in the open bell, counting them; the badge says 1', async () => {
  await page.getByRole('button', { name: /^Notifications/ }).click();
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  const send = (name) => page.evaluate(async ([t, n]) => (await fetch(`/api/public/links/${t}/upload?name=${n}&from=Bob%20Client`, { method: 'POST', body: 'x', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' } })).status, [token, name]);
  if (await send('a.pdf') !== 201) throw new Error('send');
  await panel.getByText('Bob Client sent “a.pdf”').waitFor();
  await send('b.pdf');
  await send('c.pdf');
  await panel.getByText('Bob Client sent 3 files').waitFor();
  await panel.getByText('Into Receipts through a file request, the latest “c.pdf”').waitFor();
  if (await panel.getByText('Bob Client sent “a.pdf”').count()) throw new Error('the single one stays too');
  await page.getByRole('button', { name: 'Notifications, 1 new' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/request-grouped.png` });
});
await step('after a reload it is still one', async () => {
  await page.reload();
  await page.getByRole('button', { name: 'Notifications, 1 new' }).click();
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  await panel.getByText('Bob Client sent 3 files').waitFor();
  if ((await panel.locator('.bell-item').count()) !== 1) throw new Error(String(await panel.locator('.bell-item').count()));
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
