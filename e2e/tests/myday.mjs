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
let list, t1, t2, t3;
await step('My Day: empty, with suggestions due today or overdue; + adds one', async () => {
  const today = new Date(), yesterday = new Date(Date.now() - 864e5);
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Work' })).body.id;
  t1 = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Pay invoice', due: iso(yesterday) })).body;
  t2 = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Book flights', due: iso(today) })).body;
  t3 = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Write report' })).body;
  await page.goto(`${B}/tasks/myday`);
  await page.getByText('Nothing picked for today yet').waitFor();
  const sug = page.getByRole('region', { name: 'Suggestions for My Day' });
  await sug.getByText('Pay invoice').waitFor();
  await sug.getByText('Book flights').waitFor();
  if (await sug.getByText('Write report').count()) throw new Error('not due: not suggested');
  await sug.getByRole('button', { name: 'Add to My Day: Pay invoice' }).click();
  await page.getByRole('list', { name: 'Tasks' }).getByText('Pay invoice').waitFor();
  await until(async () => !(await sug.getByText('Pay invoice').count()));
  await until(async () => (await page.locator('.subnav-item', { hasText: 'My Day' }).locator('.count').textContent().catch(() => '')) === '1');
});
await step('☀ in a task’s details adds it from its own list; ticking it off moves it to Completed', async () => {
  await page.goto(`${B}/tasks/${list}?task=${t3.id}`);
  const details = page.getByRole('complementary', { name: 'Task details' });
  await details.getByRole('button', { name: 'Add to My Day' }).click();
  await page.getByText('“Write report” added to My Day').waitFor();
  await details.getByRole('button', { name: 'Remove from My Day' }).waitFor();
  await page.getByRole('button', { name: /My Day/ }).first().click();
  const tasks = page.getByRole('list', { name: 'Tasks' });
  await tasks.getByText('Write report').waitFor();
  await tasks.getByText('Pay invoice').waitFor();
  await page.screenshot({ path: `${SP}/shots/myday.png` });
  await page.getByLabel('Done: Pay invoice').click();
  await page.getByRole('button', { name: /Completed \(1\)/ }).waitFor();
  await until(async () => (await page.locator('.subnav-item', { hasText: 'My Day' }).locator('.count').textContent().catch(() => '')) === '1');
  // Taking one off from its details.
  await page.goto(`${B}/tasks/${list}?task=${t3.id}`);
  await page.getByRole('complementary', { name: 'Task details' }).getByRole('button', { name: 'Remove from My Day' }).click();
  await page.getByText('Taken off My Day').waitFor();
  const left = (await api(page, 'GET', `/tasks/myday?today=${iso(new Date())}`)).body.map((t) => t.title);
  if (JSON.stringify(left) !== JSON.stringify(['Pay invoice'])) throw new Error(JSON.stringify(left));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
