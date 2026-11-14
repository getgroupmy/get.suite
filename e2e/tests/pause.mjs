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
let ch, kimId;
await step('pause notifications for an hour from the account menu', async () => {
  kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  ch = (await api(page, 'POST', '/chat/channels', { name: 'office' })).body.id;
  await api(page, 'POST', '/chat/dm', { user_id: kimId });
  await page.goto(`${B}/chat`);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Pause notifications: for 1 hour' }).click();
  await page.getByText(/^Notifications paused until /).first().waitFor();
  await page.getByRole('button', { name: /^Notifications paused until .*Resume$/ }).waitFor();
});
await step('a colleague sees 🔕; a mention makes no pop-up while paused', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/chat`);
  await kim.getByRole('button', { name: /Olivia Owner/ }).getByLabel('Notifications paused').waitFor();
  await page.getByRole('button', { name: '# general' }).or(page.getByRole('button', { name: /general/ })).first().click();
  await api(kim, 'POST', `/chat/channels/${ch}/messages`, { body: '@olivia@acme.com quiet one' });
  await page.waitForTimeout(1500);
  if (await page.getByText('mentioned you: ').count()) throw new Error('a pop-up while paused');
}, kim);
await step('resuming brings pop-ups back', async () => {
  await page.getByRole('button', { name: /^Notifications paused until .*Resume$/ }).click();
  await page.getByText('Notifications are back on').waitFor();
  await api(kim, 'POST', `/chat/channels/${ch}/messages`, { body: '@olivia@acme.com loud one' });
  await page.getByText(/mentioned you: .*loud one/).waitFor();
  await kim.reload();
  await kim.getByRole('button', { name: /Olivia Owner/ }).waitFor();
  await kim.waitForTimeout(500);
  if (await kim.getByRole('button', { name: /Olivia Owner/ }).getByLabel('Notifications paused').count()) throw new Error('still 🔕');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
