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
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
let list, t;
await step('delete a task, Undo brings it back; delete again and restore it from Deleted tasks', async () => {
  const list = (await api(page, 'POST', '/tasks/lists', { name: 'Home' })).body.id;
  const t = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Fix the tap', notes: 'Kitchen' })).body;
  await api(page, 'POST', `/tasks/tasks/${t.id}/comments`, { body: 'Washer size 15mm' });
  await page.goto(`${B}/tasks/${list}?task=${t.id}`);
  const details = page.getByRole('complementary', { name: 'Task details' });
  await details.getByRole('button', { name: 'Delete task' }).click();
  await until(async () => !(await task(page, 'Fix the tap').count()));
  await page.getByRole('button', { name: 'Undo' }).click();
  await task(page, 'Fix the tap').waitFor();
  await task(page, 'Fix the tap').locator('.task-main').click();
  await details.getByRole('button', { name: 'Delete task' }).click();
  await until(async () => !(await task(page, 'Fix the tap').count()));
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Deleted tasks…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Deleted tasks · Home' });
  await dlg.getByText('Fix the tap').waitFor();
  await page.screenshot({ path: `${SP}/shots/task-trash.png` });
  await dlg.getByRole('button', { name: 'Restore Fix the tap' }).click();
  await dlg.getByText('Nothing deleted in the last 30 days.').waitFor();
  await dlg.getByRole('button', { name: 'Close' }).last().click();
  await task(page, 'Fix the tap').waitFor();
  const c = (await api(page, 'GET', `/tasks/tasks/${t.id}/comments`)).body;
  if (c[0]?.body !== 'Washer size 15mm') throw new Error(JSON.stringify(c));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
