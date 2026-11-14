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
let folder, kimId;
await step('transfer a folder to a colleague from its menu', async () => {
  kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  folder = (await api(page, 'POST', '/files/folder', { name: 'Projects' })).body;
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan', parent_id: folder.id });
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Projects' }).click();
  await page.getByRole('menuitem', { name: 'Transfer ownership…' }).click();
  const d = page.getByRole('dialog', { name: 'Transfer ownership' });
  await d.getByLabel('New owner').selectOption({ label: 'Kim Park (kim@acme.com)' });
  await d.getByRole('button', { name: 'Transfer' }).click();
  await page.getByText('Kim Park now owns “Projects” (2 items). You can still edit it.').waitFor();
  const f = (await api(page, 'GET', `/files/${folder.id}`)).body;
  if (f.role !== 'editor' || f.owner_id !== kimId) throw new Error(JSON.stringify(f));
});
await step('deleting someone, their files can go to a colleague', async () => {
  const lee = (await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' })).body;
  const lp = await mk('lee'); await signIn(lp, 'lee@acme.com');
  const notes = (await api(lp, 'POST', '/files/new', { kind: 'doc', name: 'Lee notes' })).body;
  await page.goto(`${B}/admin`);
  await page.getByRole('button', { name: 'Actions for Lee Chan' }).click();
  await page.getByRole('menuitem', { name: 'Delete user and their files' }).click();
  const d = page.getByRole('dialog', { name: 'Delete Lee Chan?' });
  await d.getByLabel('Their Drive files').selectOption({ label: 'Give them to Kim Park' });
  await d.getByRole('button', { name: 'Delete user' }).click();
  await page.getByText('User deleted; 1 file given to Kim Park').waitFor();
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  const got = await api(kim, 'GET', `/files/${notes.id}`);
  if (got.status !== 200 || got.body.role !== 'owner') throw new Error(JSON.stringify(got));
  await kim.goto(`${B}/drive`);
  await kim.getByText('Files from Lee Chan').waitFor();
  void lee;
});
await step('offboarding: their email and the meetings they organise go to a colleague', async () => {
  await api(page, 'POST', '/users', { local: 'ned', domain: 'acme.com', name: 'Ned Leaving', password: 'password123' });
  const np = await mk('ned'); await signIn(np, 'ned@acme.com');
  const start = Date.now() + 2 * 864e5;
  const ev = (await api(np, 'POST', '/events', { title: 'Supplier call', start, end: start + 36e5 })).body;
  await page.goto(`${B}/admin`);
  await page.getByRole('button', { name: 'Actions for Ned Leaving' }).click();
  await page.getByRole('menuitem', { name: 'Delete user and their files' }).click();
  const d = page.getByRole('dialog', { name: 'Delete Ned Leaving?' });
  await d.getByLabel('Email sent to ned@acme.com from now on').selectOption({ label: 'Send it to Kim Park' });
  await d.getByLabel('Upcoming meetings they organise').selectOption({ label: 'Kim Park organises them' });
  await d.screenshot({ path: `${SP}/shots/offboard.png` });
  await d.getByRole('button', { name: 'Delete user' }).click();
  await page.getByText('User deleted; their email now goes to kim@acme.com; 1 meeting given to Kim Park').waitFor();
  const evs = (await api(kim, 'GET', `/events?from=${start - 1}&to=${start + 36e5}`)).body;
  if (!evs.some((e) => e.id === ev.id && e.role === 'organizer')) throw new Error(JSON.stringify(evs));
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
