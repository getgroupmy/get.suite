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
await step('Schedule lists the coming events day by day, all-day first, with tasks too', async () => {
  const d = (n, h, m = 0) => { const x = new Date(); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() + n); x.setHours(h, m); return x.getTime(); };
  await api(page, 'POST', '/events', { title: 'Dentist', location: 'High St', start: d(2, 15), end: d(2, 16) });
  await api(page, 'POST', '/events', { title: 'Team breakfast', start: d(2, 8, 30), end: d(2, 9, 30) });
  await api(page, 'POST', '/events', { title: 'Conference', all_day: 1, start: d(2, 0), end: d(3, 0) - 1 });
  await api(page, 'POST', '/events', { title: 'Far away', start: d(40, 10), end: d(40, 11) });
  const list = (await api(page, 'GET', '/tasks/lists')).body.lists[0].id;
  const due = new Date(d(5, 12)); const iso = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'File the VAT return', due: iso });
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Schedule' }).click();
  const sched = page.getByRole('list', { name: 'Schedule' });
  await sched.getByText('Dentist').waitFor();
  const day = sched.locator('.schedule-day', { hasText: 'Dentist' });
  const order = await day.locator('.schedule-item .what').allInnerTexts();
  if (order.map((t) => t.split(' · ')[0]).join('|') !== 'Conference|Team breakfast|Dentist') throw new Error(order.join('|'));
  await day.getByText('· High St').waitFor();
  await sched.getByText('File the VAT return').waitFor();
  if (await sched.getByText('Far away').count()) throw new Error('beyond four weeks');
  await page.screenshot({ path: `${SP}/shots/schedule.png` });
});
await step('the arrow moves four weeks on; clicking an event opens it; the choice is remembered', async () => {
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.getByRole('list', { name: 'Schedule' }).getByText('Far away').waitFor();
  await page.getByRole('list', { name: 'Schedule' }).getByText('Far away').click();
  await page.getByRole('dialog', { name: 'Edit event' }).waitFor();
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('radio', { name: 'Schedule' }).and(page.locator('[aria-checked="true"]')).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
