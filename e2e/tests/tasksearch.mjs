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
await step('search finds tasks on any of your lists, including steps and notes', async () => {
  const lists = (await api(page, 'GET', '/tasks/lists')).body.lists;
  const home = lists[0].id;
  const work = (await api(page, 'POST', '/tasks/lists', { name: 'Work' })).body.id;
  await api(page, 'POST', `/tasks/lists/${home}/tasks`, { title: 'Renew insurance', notes: 'car policy' });
  const g = (await api(page, 'POST', `/tasks/lists/${work}/tasks`, { title: 'Garage visit' })).body;
  await api(page, 'POST', `/tasks/tasks/${g.id}/steps`, { title: 'Ask about insurance' });
  await api(page, 'POST', `/tasks/lists/${work}/tasks`, { title: 'Unrelated' });
  await page.goto(`${B}/tasks/${home}`);
  await page.getByLabel('Search tasks').fill('insurance');
  await page.getByLabel('Search tasks').press('Enter');
  const res = page.getByRole('list', { name: 'Search results' });
  await res.getByText('Garage visit').waitFor();
  const titles = await res.locator('.task-title').allInnerTexts();
  if (titles.sort().join('|') !== 'Garage visit|Renew insurance') throw new Error(titles.join('|'));
  await res.locator('li', { hasText: 'Garage visit' }).getByText('Work').waitFor();
});
await step('opening a result goes to its list with the task open', async () => {
  await page.getByRole('list', { name: 'Search results' }).getByText('Garage visit').click();
  await page.getByRole('heading', { name: 'Work' }).waitFor();
  const d = page.getByRole('complementary', { name: 'Task details' });
  await d.waitFor();
  if ((await d.getByLabel('Task', { exact: true }).inputValue()) !== 'Garage visit') throw new Error('wrong task open');
});
await step('no match says so; closing goes back to the list', async () => {
  await page.getByLabel('Search tasks').fill('zebra');
  await page.getByLabel('Search tasks').press('Enter');
  await page.getByText('No tasks found').waitFor();
  await page.getByRole('button', { name: 'Close search' }).click();
  await page.getByRole('heading', { name: 'Work' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
