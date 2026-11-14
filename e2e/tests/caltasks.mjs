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
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = new Date();
let listId;
await step('setup: tasks with and without dates', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  listId = (await api(page, 'GET', '/tasks/lists')).body.lists[0].id;
  await api(page, 'POST', `/tasks/lists/${listId}/tasks`, { title: 'Pay the rent', due: iso(today) });
  await api(page, 'POST', `/tasks/lists/${listId}/tasks`, { title: 'No date here' });
  await api(page, 'POST', '/events', { title: 'Team lunch', start: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12).getTime(), end: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 13).getTime(), all_day: false });
});
await step('due tasks show on the month view next to events', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Month' }).click();
  const cell = page.locator('.month .day.today');
  await cell.locator('.task-chip', { hasText: 'Pay the rent' }).waitFor();
  await cell.getByText('Team lunch').waitFor();
  if (await page.getByText('No date here').count()) throw new Error('tasks without a date stay off');
  await page.screenshot({ path: `${SP}/shots/cal-tasks.png` });
});
await step('and in the week view’s all-day row; a task added elsewhere appears live', async () => {
  await page.getByRole('radio', { name: 'Week' }).click();
  await page.locator('.tg-allday .task-chip', { hasText: 'Pay the rent' }).waitFor();
  await api(page, 'POST', `/tasks/lists/${listId}/tasks`, { title: 'Water the plants', due: iso(today) });
  await page.locator('.tg-allday .task-chip', { hasText: 'Water the plants' }).waitFor();
});
await step('ticking one off on the calendar completes it (with Undo)', async () => {
  await page.getByRole('button', { name: 'Mark done: Water the plants' }).click();
  await page.locator('.task-chip', { hasText: 'Water the plants' }).waitFor({ state: 'detached' });
  const t = (await api(page, 'GET', `/tasks/lists/${listId}/tasks`)).body.find((x) => x.title === 'Water the plants');
  if (!t.done) throw new Error('not done');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await page.locator('.task-chip', { hasText: 'Water the plants' }).waitFor();
});
await step('clicking a task opens it in Tasks', async () => {
  await page.locator('.task-chip .task-open', { hasText: 'Pay the rent' }).click();
  await page.getByRole('heading', { name: 'My tasks' }).waitFor();
  const d = page.getByRole('complementary', { name: 'Task details' });
  await until(async () => (await d.getByLabel('Task', { exact: true }).inputValue()) === 'Pay the rent');
});
await step('tasks can be hidden, and stay hidden', async () => {
  await page.goto(`${B}/calendar`);
  await page.locator('.task-chip').first().waitFor();
  await page.getByLabel('Show tasks with due dates').uncheck();
  await until(async () => (await page.locator('.task-chip').count()) === 0);
  await page.reload();
  await page.getByText('Team lunch').first().waitFor({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  if (await page.locator('.task-chip').count()) throw new Error('still shown');
  if (await page.getByLabel('Show tasks with due dates').isChecked()) throw new Error('setting not kept');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
