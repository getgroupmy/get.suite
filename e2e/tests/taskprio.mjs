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
let list;
await step('quick add: !high sets a priority, shown on the task', async () => {
  list = (await api(page, 'POST', '/tasks/lists', { name: 'House' })).body.id;
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Sweep the yard' });
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Paint the fence' });
  await page.goto(`${B}/tasks/${list}`);
  const box = page.getByPlaceholder(/Add a task/);
  await box.fill('Fix the roof !high');
  await page.getByRole('status', { name: 'Quick add' }).getByText('High !!! priority').waitFor().catch(async () => { await page.getByRole('status', { name: 'Quick add' }).getByText(/High priority/).waitFor(); });
  await box.press('Enter');
  await task(page, 'Fix the roof').getByLabel('High priority').waitFor();
  const t = (await api(page, 'GET', `/tasks/lists/${list}/tasks`)).body.find((x) => x.title === 'Fix the roof');
  if (t.priority !== 'high') throw new Error(t.priority);
});
await step('set one in the details; sort by priority', async () => {
  await task(page, 'Sweep the yard').locator('.task-title').click();
  const details = page.getByRole('complementary', { name: 'Task details' });
  await details.getByLabel('Priority').selectOption('low');
  await task(page, 'Sweep the yard').getByLabel('Low priority').waitFor();
  await page.getByRole('button', { name: /^Sort:/ }).click();
  await page.getByRole('menuitem', { name: 'Priority' }).click();
  await until(async () => (await titles()).join('|') === 'Fix the roof|Sweep the yard|Paint the fence');
  await page.screenshot({ path: `${SP}/shots/task-priority.png` });
  await page.reload();
  await until(async () => (await titles()).join('|') === 'Fix the roof|Sweep the yard|Paint the fence');
});
await step('the board shows it too; the title stays readable beside the buttons', async () => {
  const w = await page.locator('.tasks-main .page-head h1').evaluate((el) => el.getBoundingClientRect().width);
  if (w < 100) throw new Error(`title squeezed to ${w}px`);
  await page.getByRole('tab', { name: 'Board' }).click();
  await page.locator('.board-card', { hasText: 'Fix the roof' }).getByLabel('High priority').waitFor();
  await page.getByRole('tab', { name: 'List' }).click();
});
await step('several at once from the Select bar', async () => {
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Select all' }).click();
  await page.getByLabel('Priority for the selected tasks').selectOption('medium');
  await page.getByText(/3 tasks: medium priority/).waitFor();
  await until(async () => (await api(page, 'GET', `/tasks/lists/${list}/tasks`)).body.filter((x) => x.priority === 'medium').length === 3);
  await page.getByRole('button', { name: 'Done selecting' }).click();
  for (const [title, p] of [['Fix the roof', 'high'], ['Sweep the yard', 'low']]) {
    const id = (await api(page, 'GET', `/tasks/lists/${list}/tasks`)).body.find((x) => x.title === title).id;
    await api(page, 'PATCH', `/tasks/tasks/${id}`, { priority: p });
  }
  await page.reload();
  await task(page, 'Sweep the yard').getByLabel('Low priority').waitFor();
});
await step('none takes it off; the download has it', async () => {
  const csv = await page.evaluate(async (id) => (await fetch(`/api/tasks/lists/${id}/export.csv`)).text(), list);
  if (!/Priority/.test(csv.split('\n')[0]) || !/Fix the roof,.*High/.test(csv)) throw new Error(csv.slice(0, 300));
  // Open it by its address: clicking the task that's already open would close its details instead.
  const sweep = (await api(page, 'GET', `/tasks/lists/${list}/tasks`)).body.find((x) => x.title === 'Sweep the yard').id;
  await page.goto(`${B}/tasks/${list}?task=${sweep}`);
  await page.getByRole('complementary', { name: 'Task details' }).getByLabel('Priority').selectOption('');
  await until(async () => (await task(page, 'Sweep the yard').getByLabel('Low priority').count()) === 0);
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
