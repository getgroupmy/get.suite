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
const openTask = (t) => page.getByRole('list', { name: 'Tasks', exact: true }).locator('.task', { has: page.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const today = new Date();
const add = (n) => iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));
await step('choosing Repeat on a task without a date sets it due today', async () => {
  await page.getByRole('link', { name: 'Tasks', exact: true }).click();
  await page.getByRole('heading', { name: 'My tasks' }).waitFor();
  await page.getByLabel('Add a task').fill('Water plants');
  await page.keyboard.press('Enter');
  await task(page, 'Water plants').locator('.task-main').click();
  const d = page.getByRole('complementary', { name: 'Task details' });
  await d.getByLabel('Repeat', { exact: true }).selectOption('daily');
  await task(page, 'Water plants').getByText('⟳ Daily').waitFor();
  await task(page, 'Water plants').locator('.pill.due', { hasText: 'Today' }).waitFor();
  if ((await d.getByLabel('Due date', { exact: true }).inputValue()) !== add(0)) throw new Error('due ' + await d.getByLabel('Due date', { exact: true }).inputValue());
  await page.keyboard.press('Escape');
});
await step('ticking it off brings the next one, due tomorrow; Undo takes it away', async () => {
  await page.getByLabel('Done: Water plants').click();
  await page.locator('.toast', { hasText: '“Water plants” done · next due Tomorrow' }).waitFor();
  await until(async () => (await titles()).join('|') === 'Water plants');
  await task(page, 'Water plants').locator('.pill.due', { hasText: 'Tomorrow' }).waitFor();
  await task(page, 'Water plants').getByText('⟳ Daily').waitFor();
  await page.getByRole('button', { name: 'Completed (1)' }).click();
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await until(async () => (await titles()).join('|') === 'Water plants' && (await page.getByRole('button', { name: /^. Completed \(/ }).count()) === 0);
  await task(page, 'Water plants').locator('.pill.due', { hasText: 'Today' }).waitFor();
});
await step('an overdue weekly task comes back on its weekday, from today on', async () => {
  const list = (await api(page, 'GET', '/tasks/lists')).body.lists[0].id;
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Team report', due: add(-9), repeat: 'weekly' });
  await task(page, 'Team report').waitFor();
  await page.getByLabel('Done: Team report').click();
  await until(async () => (await titles()).includes('Team report'));
  const t = (await api(page, 'GET', `/tasks/lists/${list}/tasks`)).body.find((x) => x.title === 'Team report' && !x.done);
  if (t.due !== add(5)) throw new Error(`next ${t.due} want ${add(5)}`);
});
await step('Does not repeat stops it; clearing the date does too', async () => {
  await openTask('Team report').locator('.task-main').click();
  const d = page.getByRole('complementary', { name: 'Task details' });
  await d.getByLabel('Repeat', { exact: true }).selectOption('');
  await until(async () => (await openTask('Team report').getByText('⟳').count()) === 0);
  await openTask('Water plants').locator('.task-main').click();
  await until(async () => (await d.getByLabel('Task', { exact: true }).inputValue()) === 'Water plants');
  await d.getByRole('button', { name: 'Clear' }).click();
  await until(async () => (await openTask('Water plants').getByText('⟳').count()) === 0);
  if ((await d.getByLabel('Repeat', { exact: true }).inputValue()) !== '') throw new Error('repeat kept');
});
await step('ticking a repeating task off in Calendar shows the next one there', async () => {
  const list = (await api(page, 'GET', '/tasks/lists')).body.lists[0].id;
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Stand-up notes', due: add(0), repeat: 'daily' });
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  await page.getByRole('button', { name: 'Mark done: Stand-up notes' }).first().click();
  await until(async () => (await (await api(page, 'GET', `/tasks/due?from=${add(1)}&to=${add(1)}`)).body).some((x) => x.title === 'Stand-up notes'));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
