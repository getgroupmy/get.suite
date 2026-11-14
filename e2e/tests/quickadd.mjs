import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
const tasksNow = async (listId) => (await api(page, 'GET', `/tasks/lists/${listId}/tasks`)).body;
let list;
await step('quick add reads the date, time, repeat and star, and shows them first', async () => {
  await page.goto(`${B}/tasks`);
  const box = page.getByLabel('Add a task');
  await box.waitFor();
  list = (await api(page, 'GET', '/tasks/lists')).body.lists.find((l) => l.mine);
  await box.fill('Send invoice tomorrow 3pm every month !');
  const pv = page.getByRole('status', { name: 'Quick add' });
  await pv.getByText('Send invoice', { exact: true }).waitFor();
  await pv.getByText('📅 Tomorrow 15:00').waitFor();
  await pv.getByText('⟳ Monthly').waitFor();
  await pv.getByText('★ Important').waitFor();
  await box.press('Enter');
  await until(async () => { const l = await tasksNow(list.id); const ts = Array.isArray(l) ? l : l.tasks; return ts?.some((t) => t.title === 'Send invoice' && t.due_time === '15:00' && t.repeat === 'monthly' && t.important); });
  await page.getByText('Send invoice', { exact: true }).waitFor();
  if (await pv.count()) throw new Error('preview still shown');
});
await step('"Keep as typed" adds the words as they are', async () => {
  const box = page.getByLabel('Add a task');
  await box.fill('Read chapter on Friday');
  const pv = page.getByRole('status', { name: 'Quick add' });
  await pv.getByText(/📅/).waitFor();
  await pv.getByRole('button', { name: 'Keep as typed' }).click();
  await pv.getByText('Adding just as typed.').waitFor();
  await box.press('Enter');
  await until(async () => { const l = await tasksNow(list.id); const ts = Array.isArray(l) ? l : l.tasks; return ts?.some((t) => t.title === 'Read chapter on Friday' && !t.due); });
});
await step('@name gives it to someone on a shared list', async () => {
  const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const shared = (await api(page, 'POST', '/tasks/lists', { name: 'Team' })).body;
  const sid = shared.id || shared.list?.id;
  const r = await api(page, 'PUT', `/tasks/lists/${sid}/members`, { user_ids: [kim] });
  if (r.status >= 300) { const r2 = await api(page, 'PUT', `/tasks/lists/${sid}/share`, { user_ids: [kim] }); if (r2.status >= 300) throw new Error('share ' + JSON.stringify(r2)); }
  await page.goto(`${B}/tasks/${sid}`);
  const box = page.getByLabel('Add a task');
  await box.fill('Book the venue @kim by fri');
  const pv = page.getByRole('status', { name: 'Quick add' });
  await pv.getByText('👤 Kim Park').waitFor();
  await box.press('Enter');
  await until(async () => { const l = await tasksNow(sid); const ts = Array.isArray(l) ? l : l.tasks; return ts?.some((t) => t.title === 'Book the venue' && t.assignee_id === kim && t.due); });
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
