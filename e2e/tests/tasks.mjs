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
await step('Tasks in the app bar opens your own list; Enter adds tasks on top', async () => {
  await page.getByRole('link', { name: 'Tasks', exact: true }).click();
  await page.getByRole('heading', { name: 'My tasks' }).waitFor();
  await page.getByText('No tasks yet').waitFor();
  for (const t of ['Renew passport', 'Call the bank', 'Buy printer ink']) { await page.getByLabel('Add a task').fill(t); await page.keyboard.press('Enter'); await task(page, t).waitFor(); }
  const got = await titles();
  if (got.join('|') !== 'Buy printer ink|Call the bank|Renew passport') throw new Error(got.join('|'));
  await page.locator('.subnav-item', { hasText: 'My tasks' }).getByText('3').waitFor();
});
await step('tick one off: it moves to Completed, and Undo brings it back', async () => {
  await page.getByLabel('Done: Call the bank').click();
  await until(async () => !(await titles()).includes('Call the bank'));
  await page.getByRole('button', { name: 'Completed (1)' }).click();
  await page.getByRole('list', { name: 'Completed tasks' }).getByText('Call the bank').waitFor();
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await until(async () => (await titles())[0] === 'Call the bank');
});
await step('drag a task into place; the order is kept', async () => {
  await task(page, 'Renew passport').dragTo(task(page, 'Call the bank'), { targetPosition: { x: 40, y: 4 } });
  await until(async () => (await titles()).join('|') === 'Renew passport|Call the bank|Buy printer ink');
  await page.reload();
  await task(page, 'Renew passport').waitFor();
  const got = await titles();
  if (got.join('|') !== 'Renew passport|Call the bank|Buy printer ink') throw new Error(got.join('|'));
});
await step('details: notes and a due date; overdue and today show in colour', async () => {
  await task(page, 'Renew passport').locator('.task-main').click();
  const d = page.getByRole('complementary', { name: 'Task details' });
  await d.getByLabel('Notes').fill('Photos first');
  await d.getByLabel('Due date', { exact: true }).fill(iso(new Date()));
  await task(page, 'Renew passport').locator('.pill.due.soon', { hasText: 'Today' }).waitFor();
  await task(page, 'Renew passport').getByText('Photos first').waitFor();
  await task(page, 'Buy printer ink').locator('.task-main').click();
  await until(async () => (await d.getByLabel('Task', { exact: true }).inputValue()) === 'Buy printer ink');
  await d.getByLabel('Due date', { exact: true }).fill(iso(new Date(Date.now() - 3 * 864e5)));
  await task(page, 'Buy printer ink').locator('.pill.due.late').waitFor();
  await d.getByLabel('Task', { exact: true }).fill('Buy printer ink (black)');
  await d.getByLabel('Task', { exact: true }).press('Enter');
  await task(page, 'Buy printer ink \\(black\\)').waitFor();
  await page.keyboard.press('Escape');
  await d.waitFor({ state: 'detached' });
});
await step('a shared list: Kim sees it live, and a task given to her is under Assigned to me', async () => {
  await page.getByRole('button', { name: 'New list' }).click();
  await page.getByLabel('List name').fill('Office move');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('heading', { name: 'Office move' }).waitFor();
  for (const t of ['Pack the server room', 'Order boxes']) { await page.getByLabel('Add a task').fill(t); await page.keyboard.press('Enter'); await task(page, t).waitFor(); }
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByRole('dialog').getByLabel(/Kim Park/).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Shared with 1' }).waitFor();
  await kim.goto(`${B}/tasks`);
  await kim.locator('.subnav-item', { hasText: 'Office move' }).click();
  await kim.getByText('Shared by Olivia Owner').waitFor();
  await task(page, 'Order boxes').locator('.task-main').click();
  await until(async () => (await page.getByRole('complementary', { name: 'Task details' }).getByLabel('Task', { exact: true }).inputValue()) === 'Order boxes');
  await page.getByRole('complementary', { name: 'Task details' }).getByLabel('Assigned to').selectOption({ label: 'Kim Park' });
  await task(kim, 'Order boxes').getByTitle('For Kim Park').waitFor();
  await kim.locator('.subnav-item', { hasText: 'Assigned to me' }).getByText('1').waitFor();
  await kim.locator('.subnav-item', { hasText: 'Assigned to me' }).click();
  await task(kim, 'Order boxes').getByText('Office move').waitFor();
  await page.screenshot({ path: `${SP}/shots/tasks.png` });
});
await step('Kim ticks it off; Olivia sees it done', async () => {
  await kim.getByLabel('Done: Order boxes').click();
  await kim.getByText('Nothing assigned to you').waitFor();
  await page.getByRole('button', { name: 'Completed (1)' }).waitFor();
  await page.getByRole('button', { name: 'Completed (1)' }).click();
  await page.getByRole('list', { name: 'Completed tasks' }).getByText('Order boxes').waitFor();
});
await step('Kim adds a task to the shared list; Olivia sees it at once', async () => {
  await kim.locator('.subnav-item', { hasText: 'Office move' }).click();
  await kim.getByLabel('Add a task').fill('Label the cables');
  await kim.keyboard.press('Enter');
  await task(page, 'Label the cables').waitFor();
});
await step('move a task to another list; delete a list', async () => {
  await task(page, 'Pack the server room').locator('.task-main').click();
  await until(async () => (await page.getByRole('complementary', { name: 'Task details' }).getByLabel('Task', { exact: true }).inputValue()) === 'Pack the server room');
  await page.getByRole('complementary', { name: 'Task details' }).getByLabel('List').selectOption({ label: 'My tasks' });
  await page.locator('.toast', { hasText: 'Moved to My tasks' }).waitFor();
  await task(page, 'Pack the server room').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete list' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete list' }).click();
  await page.getByRole('heading', { name: 'My tasks' }).waitFor();
  await task(page, 'Pack the server room').waitFor();
  await kim.locator('.subnav-item', { hasText: 'Office move' }).waitFor({ state: 'detached' });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
