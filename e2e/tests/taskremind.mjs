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
let kim, shared, me;
if (new Date().getHours() < 9) console.log('PASS (note: before 9:00, the morning steps only check that nothing shows)');
await step('setup: a task due today and one overdue', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const list = (await api(page, 'GET', '/tasks/lists')).body.lists[0].id;
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Pay the rent', due: iso(new Date()) });
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Send the invoice', due: iso(new Date(Date.now() - 2 * 864e5)) });
  me = (await api(page, 'GET', '/auth/me')).body.user.id;
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  shared = (await api(kim, 'POST', '/tasks/lists', { name: 'Launch' })).body.id;
  await api(kim, 'PUT', `/tasks/lists/${shared}/members`, { user_ids: [me] });
});
await step('the morning note: once, with a way to the tasks', async () => {
  await page.goto(`${B}/drive`);
  const note = page.locator('.toast', { hasText: '“Pay the rent” is due today, and 1 is overdue' });
  if (new Date().getHours() < 9) { await page.waitForTimeout(2000); if (await note.count()) throw new Error('too early'); return; }
  await note.waitFor();
  await note.getByRole('button', { name: 'Open Tasks' }).click();
  await page.getByRole('heading', { name: 'My tasks' }).waitFor();
  await page.goto(`${B}/drive`);
  await page.waitForTimeout(2500);
  if (await page.locator('.toast', { hasText: 'is due today' }).count()) throw new Error('shown again');
});
await step('a task given to you by someone else: a note straight away', async () => {
  await page.goto(`${B}/drive`);
  await page.waitForTimeout(1000);
  await api(kim, 'POST', `/tasks/lists/${shared}/tasks`, { title: 'Write the press release', assignee_id: me });
  const note = page.locator('.toast', { hasText: 'Kim Park gave you “Write the press release” on Launch' });
  await note.waitFor();
  await note.getByRole('button', { name: 'Open' }).click();
  const d = page.getByRole('complementary', { name: 'Task details' });
  await until(async () => (await d.getByLabel('Task', { exact: true }).inputValue()) === 'Write the press release');
});
await step('giving yourself a task makes no note', async () => {
  const t = (await api(page, 'POST', `/tasks/lists/${shared}/tasks`, { title: 'Mine anyway' })).body;
  await api(page, 'PATCH', `/tasks/tasks/${t.id}`, { assignee_id: me });
  await page.waitForTimeout(1500);
  if (await page.locator('.toast', { hasText: 'Mine anyway' }).count()) throw new Error('no note for yourself');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
