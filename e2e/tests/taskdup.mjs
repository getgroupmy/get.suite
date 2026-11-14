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
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
let list, t;
await step('Duplicate puts a copy just below, with its steps', async () => {
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Work' })).body.id;
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Other thing' });
  t = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Water the plants', due: day(0), repeat: 'weekly' })).body;
  await api(page, 'POST', `/tasks/tasks/${t.id}/steps`, { title: 'Office ones' });
  await page.goto(`${B}/tasks/${list}?task=${t.id}`);
  const details = page.getByRole('complementary', { name: 'Task details' });
  await details.getByRole('button', { name: 'Duplicate' }).click();
  await page.getByText('Duplicated: the copy is just below').waitFor();
  const titles = page.getByRole('list', { name: 'Tasks' }).locator('.task-title');
  await until(async () => (await titles.allInnerTexts()).join('|') === 'Water the plants|Water the plants|Other thing');
});
await step('Skip this time moves a repeating task to its next date, not ticked off', async () => {
  const details = page.getByRole('complementary', { name: 'Task details' });
  await details.getByRole('button', { name: '⏭ Skip this time' }).click();
  await page.getByText(/^Skipped: next due/).waitFor();
  const now = (await api(page, 'GET', `/tasks/lists/${list}/tasks`)).body.find((x) => x.id === t.id);
  if (now.due !== day(7) || now.done) throw new Error(JSON.stringify([now.due, now.done]));
  await page.screenshot({ path: `${SP}/shots/task-skip.png` });
  // Not repeating: no Skip.
  const other = (await api(page, 'GET', `/tasks/lists/${list}/tasks`)).body.find((x) => x.title === 'Other thing');
  await page.goto(`${B}/tasks/${list}?task=${other.id}`);
  await page.getByRole('complementary', { name: 'Task details' }).getByRole('button', { name: 'Duplicate' }).waitFor();
  if (await page.getByRole('button', { name: '⏭ Skip this time' }).count()) throw new Error('skip on a one-off task');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
