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
await step('a checklist copied for the next person, its dates moved to a new start', async () => {
  const list = (await api(page, 'POST', '/tasks/lists', { name: 'Onboarding: Sam' })).body.id;
  for (const [title, due] of [['Order laptop', '2026-03-02'], ['Create accounts', '2026-03-04'], ['Welcome lunch', '2026-03-09']]) await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title, due, at: 'end' });
  await page.goto(`${B}/tasks/${list}`);
  await page.getByText('Order laptop').waitFor();
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Make a copy…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Make a copy' });
  await dlg.getByLabel('Name of the copy').fill('Onboarding: Kim');
  await dlg.getByLabel('Start on (optional)').fill('2026-12-07');
  await dlg.getByText(/earliest falls on this day/).waitFor();
  await dlg.screenshot({ path: `${SP}/shots/copy-list.png` });
  await dlg.getByRole('button', { name: 'Make a copy' }).click();
  await page.getByText('3 tasks copied to “Onboarding: Kim”').waitFor();
  // The original's address matches /tasks/… too: wait for the copy's (a different list).
  await page.waitForURL((u) => /\/tasks\/[^/]+$/.test(u.pathname) && !u.pathname.endsWith(list));
  const id = page.url().split('/tasks/')[1];
  const tasks = (await api(page, 'GET', `/tasks/lists/${id}/tasks`)).body;
  const dues = Object.fromEntries(tasks.map((t) => [t.title, t.due]));
  if (dues['Order laptop'] !== '2026-12-07' || dues['Welcome lunch'] !== '2026-12-14') throw new Error(JSON.stringify(dues));
  await page.getByRole('heading', { name: 'Onboarding: Kim' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
