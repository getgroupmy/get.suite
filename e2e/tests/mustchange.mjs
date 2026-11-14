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
let nat;
await step('an admin adds someone with a temporary password', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('button', { name: 'Add user' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Name').first().fill('Nat New');
  await d.getByLabel(/Address|before @/i).first().fill('nat');
  await d.getByLabel('Temporary password').fill('welcome-123');
  if (!(await d.getByLabel(/Ask them to choose their own password/).isChecked())) throw new Error('not asked by default');
  await d.getByRole('button', { name: /Create|Add/ }).last().click();
  await page.getByText('nat@acme.com created').waitFor();
});
await step('at first sign-in they must choose their own password', async () => {
  nat = await mk('nat'); await signIn(nat, 'nat@acme.com'.replace('nat', 'nat'));
  await nat.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'nat@acme.com', password: 'welcome-123' }) }));
  await nat.goto(`${B}/drive`);
  await nat.getByRole('heading', { name: 'Choose your own password' }).waitFor();
  await nat.getByLabel('Password you were given').fill('welcome-123');
  await nat.getByLabel('New password', { exact: true }).fill('nats-own-secret');
  await nat.getByLabel('New password again').fill('nats-own-secret');
  await nat.getByRole('button', { name: 'Save and continue' }).click();
  await nat.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const me = (await api(nat, 'GET', '/auth/me')).body.user;
  if (me.must_change_password) throw new Error('still asked');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
