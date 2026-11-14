import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
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
await step('sort contacts by last name, company and recently added; starred stay first; kept after a reload', async () => {
  for (const [name, company] of [['Zoe Adams', 'Beta'], ['Anna Young', ''], ['Bob Martin', 'Acme']]) await api(page, 'POST', '/contacts', { name, company });
  const bob = (await api(page, 'GET', '/contacts')).body.find((c) => c.name === 'Bob Martin');
  await page.goto(`${B}/contacts`);
  const names = async () => (await page.locator('table.files tbody td.name').allInnerTexts()).map((t) => t.replace(/^[A-Z]{1,2}(?=[A-Z][a-z])/, '').split('\n').pop().replace(/ ·.*/, '').trim());
  await until(async () => (await names()).join('|') === 'Anna Young|Bob Martin|Zoe Adams');
  await page.getByLabel('Sort contacts').selectOption({ label: 'Last name' });
  await until(async () => (await names()).join('|') === 'Zoe Adams|Bob Martin|Anna Young');
  await page.getByLabel('Sort contacts').selectOption({ label: 'Company' });
  await until(async () => (await names()).join('|') === 'Bob Martin|Zoe Adams|Anna Young');
  await page.reload();
  await until(async () => (await names()).join('|') === 'Bob Martin|Zoe Adams|Anna Young');
  await api(page, 'PATCH', `/contacts/${bob.id}`, { starred: false });
  const zoe = (await api(page, 'GET', '/contacts')).body.find((c) => c.name === 'Zoe Adams');
  await api(page, 'PATCH', `/contacts/${zoe.id}`, { starred: true });
  await page.getByLabel('Sort contacts').selectOption({ label: 'Recently added' });
  await page.reload();
  await until(async () => (await names()).join('|') === 'Zoe Adams|Bob Martin|Anna Young', 10000);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
