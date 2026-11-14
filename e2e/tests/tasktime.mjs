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
let list, design;
const details = (p) => p.getByRole('complementary', { name: 'Task details' });
const timeBox = (p) => details(p).getByRole('region', { name: 'Time' });
const row = (p, t) => p.getByRole('list', { name: 'Tasks', exact: true }).locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
await step('a timer on a task: started, shown on the list for everyone, stopped', async () => {
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Client work' })).body.id;
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  await api(page, 'PUT', `/tasks/lists/${list}/members`, { user_ids: [kimId] });
  design = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Design' })).body.id;
  await page.goto(`${B}/tasks/${list}`);
  await kim.goto(`${B}/tasks/${list}`);
  await row(page, 'Design').locator('.task-main').click();
  await timeBox(page).getByRole('button', { name: '▶ Start timer' }).click();
  await timeBox(page).getByRole('button', { name: /■ Stop timer/ }).waitFor();
  await row(page, 'Design').locator('.pill.timing', { hasText: 'Olivia' }).waitFor();
  await row(kim, 'Design').locator('.pill.timing', { hasText: 'Olivia' }).waitFor(); // live for the colleague
  await timeBox(page).getByRole('button', { name: /■ Stop timer/ }).click();
  await page.getByText('Timer stopped').waitFor();
  await until(async () => !(await row(kim, 'Design').locator('.pill.timing').count()));
});
await step('time added by hand, totals per person; only your own entries can be removed', async () => {
  await row(kim, 'Design').locator('.task-main').click();
  await timeBox(kim).getByRole('button', { name: 'Add time' }).click();
  await timeBox(kim).getByLabel('How long').fill('1h 30m');
  await timeBox(kim).getByLabel('What for (optional)').fill('Workshop');
  await timeBox(kim).getByRole('button', { name: 'Add', exact: true }).click();
  await timeBox(kim).getByText(/Kim Park · .* · 1 h 30 min · Workshop/).waitFor();
  await row(page, 'Design').locator('.task-time', { hasText: '1 h 30 min' }).waitFor();
  await timeBox(page).getByText(/1 h 30 min in all/).waitFor();
  await timeBox(kim).getByRole('button', { name: 'Add time' }).click();
  await timeBox(kim).getByLabel('How long').fill('lots');
  await timeBox(kim).getByRole('button', { name: 'Add', exact: true }).click();
  await kim.getByText(/Enter how long/).waitFor();
  await timeBox(kim).getByRole('button', { name: 'Cancel' }).click();
  if (await timeBox(page).getByRole('button', { name: /^Remove 1 h 30 min/ }).count()) throw new Error('could remove someone else’s');
  await timeBox(kim).getByRole('button', { name: /^Remove 1 h 30 min/ }).click();
  await until(async () => !(await timeBox(page).getByText(/1 h 30 min/).count()));
  await api(kim, 'POST', `/tasks/tasks/${design}/time`, { duration: '45m' });
});
await step('the time report: who spent how long on what, and a CSV download', async () => {
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Time report…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Time on “Client work”' });
  const table = dlg.getByRole('table', { name: 'Time report' });
  await table.getByRole('row').filter({ hasText: 'Kim Park' }).filter({ hasText: '45 min' }).waitFor();
  await table.getByRole('row').filter({ hasText: 'Olivia Owner' }).filter({ hasText: 'Design' }).waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('link', { name: 'Download CSV' }).click()]);
  const csv = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  if (!/Person,Task,Minutes,Hours/.test(csv) || !/Kim Park,Design,45,0\.75/.test(csv)) throw new Error(csv);
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
