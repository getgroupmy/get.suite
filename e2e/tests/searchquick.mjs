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
const search = () => page.getByLabel('Search everything');
const actions = () => page.getByRole('group', { name: 'Actions' });
const dlg = () => page.getByRole('dialog', { name: 'New event' });
await step('a colleague', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
});
await step('"event …" offers that event; Enter opens it in Calendar with the guest', async () => {
  await page.goto(`${B}/home`);
  await search().fill('event Lunch with @kim tomorrow 1pm');
  const hit = actions().getByRole('option').first();
  await until(async () => /^New event: Lunch with Kim/.test(await hit.textContent()));
  if (!/1:00\s?PM – 2:00\s?PM/.test(await hit.textContent())) throw new Error(await hit.textContent());
  await search().press('ArrowDown');
  await search().press('Enter');
  await page.waitForURL(/\/calendar/);
  await dlg().waitFor();
  if (await dlg().getByLabel('Title').inputValue() !== 'Lunch with Kim') throw new Error('title');
  await until(async () => (await dlg().getByRole('list', { name: 'Invited guests' }).textContent()).replace(/×/g, '').trim() === 'Kim Park');
  await dlg().getByRole('button', { name: 'Cancel' }).click();
});
await step('"task …" adds that task at once, with its due date, priority and tag', async () => {
  await search().fill('task Send invoice friday 3pm !high #billing');
  const hit = actions().getByRole('option').first();
  await until(async () => /^Add task: Send invoice/.test(await hit.textContent()));
  if (!/due .*, 15:00 · high priority · #billing/.test(await hit.textContent())) throw new Error(await hit.textContent());
  await hit.click();
  await page.getByText(/^Added to /).first().waitFor();
  const { lists } = (await api(page, 'GET', '/tasks/lists')).body;
  const got = (await api(page, 'GET', `/tasks/lists/${lists[0].id}/tasks`)).body;
  const t = (got.tasks || got).find((x) => x.title === 'Send invoice');
  if (!t || t.due_time !== '15:00' || t.priority !== 'high' || JSON.stringify(t.tags) !== '["billing"]' || new Date(`${t.due}T12:00`).getDay() !== 5) throw new Error(JSON.stringify(t));
});
await step('plain words still search; "event" alone still offers a blank new event', async () => {
  await search().fill('event');
  await until(async () => (await actions().getByRole('option').first().textContent().catch(() => '')).startsWith('New event'));
  if (/New event: /.test(await actions().textContent())) throw new Error('a detailed one for nothing');
  await search().fill('event planning');
  await page.waitForTimeout(400);
  if (await actions().count() && /New event: /.test(await actions().textContent())) throw new Error('no day or time: no detailed event');
  await page.screenshot({ path: `${SP}/shots/search-quick.png` });
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
