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
const openTask = (p, t) => p.getByRole('list', { name: 'Tasks', exact: true }).locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
let list;
await step('quick add with #tags; the row shows them', async () => {
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Sales' })).body.id;
  await page.goto(`${B}/tasks/${list}`);
  await page.getByLabel('Add a task').fill('Call Acme #client tomorrow');
  await page.getByRole('status', { name: 'Quick add' }).getByText('#client').waitFor();
  await page.getByLabel('Add a task').press('Enter');
  await openTask(page, 'Call Acme').getByText('#client').waitFor();
  await page.getByRole('button', { name: 'Tag client, 1 open' }).waitFor();
});
await step('add and remove tags in the details', async () => {
  await openTask(page, 'Call Acme').locator('.task-main').click();
  const d = page.getByRole('complementary', { name: 'Task details' });
  await d.getByLabel('Add a tag').fill('#urgent, quotes');
  await d.getByLabel('Add a tag').press('Enter');
  await openTask(page, 'Call Acme').getByText('#urgent').waitFor();
  await openTask(page, 'Call Acme').getByText('#quotes').waitFor();
  await d.getByRole('button', { name: 'Remove tag quotes' }).click();
  await until(async () => !(await openTask(page, 'Call Acme').getByText('#quotes').count()));
  await d.getByRole('button', { name: 'Close details' }).click();
});
await step('a tag gathers tasks from every list, live as one is shared and tagged', async () => {
  const kimList = (await api(kim, 'POST', '/tasks/lists', { name: 'Kim jobs' })).body.id;
  const me = (await api(page, 'GET', '/auth/me')).body.user.id;
  await api(kim, 'PUT', `/tasks/lists/${kimList}/members`, { user_ids: [me] });
  await api(kim, 'POST', `/tasks/lists/${kimList}/tasks`, { title: 'Draft contract', tags: ['client'] });
  await page.getByRole('button', { name: /^Tag client, 2 open/ }).click();
  await page.getByRole('heading', { name: '#client' }).waitFor();
  await openTask(page, 'Call Acme').waitFor();
  await openTask(page, 'Draft contract').getByText('Kim jobs').waitFor();
  await page.getByRole('button', { name: 'Tag urgent, 1 open' }).waitFor();
  // Searching finds the tag too.
  await page.getByLabel('Search tasks').fill('urgent');
  await page.getByLabel('Search tasks').press('Enter');
  await page.getByRole('list', { name: 'Search results' }).getByText('Call Acme').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
