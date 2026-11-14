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
let sal;
await step('a second admin, and Kim', async () => {
  const s = (await api(page, 'POST', '/users', { local: 'sal', domain: 'acme.com', name: 'Sal Admin', password: 'password123' })).body.id;
  await api(page, 'PATCH', `/users/${s}`, { is_admin: true });
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  sal = await mk('sal'); await signIn(sal, 'sal@acme.com');
});
await step('Olivia makes Kim an admin; Sal gets a security alert that opens Admin → Activity', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('button', { name: 'Actions for Kim Park' }).click();
  await page.getByRole('menuitem', { name: 'Make admin' }).click();
  await page.getByText('Role updated').waitFor();
  await sal.goto(`${B}/drive`);
  await sal.getByRole('button', { name: /Notifications, \d+ new/ }).click();
  await sal.getByText('Olivia Owner made kim@acme.com an admin').click();
  await sal.waitForURL(/\/admin\?tab=activity/);
  await sal.getByRole('tab', { name: 'Activity', selected: true }).waitFor();
});
await step('Sal can turn security alerts off in the bell settings', async () => {
  await sal.getByRole('button', { name: /Notifications/ }).click();
  await sal.getByRole('button', { name: /Notification settings/ }).click();
  await sal.getByLabel('Security alerts (admins)').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
