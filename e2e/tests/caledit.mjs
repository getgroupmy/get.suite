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
const evs = async (p) => (await api(p, 'GET', `/events?from=${Date.now() - 864e5}&to=${Date.now() + 7 * 864e5}`)).body.map((e) => e.title);
await step('Olivia lets Kim make and change events on her calendar', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Share my calendar' }).click();
  const dlg = page.getByRole('dialog', { name: 'Share my calendar' });
  await dlg.getByLabel('Share with a colleague').selectOption({ label: 'Kim Park' });
  await dlg.getByLabel('Kim Park can make and change events').check();
  await until(async () => (await api(page, 'GET', '/freebusy/shares')).body.with.some((u) => u.can_edit));
  await dlg.getByRole('button', { name: 'Done' }).click();
});
await step('Kim picks Olivia’s calendar and adds an event: it’s Olivia’s, and she’s told', async () => {
  await kim.goto(`${B}/calendar`);
  await kim.getByLabel('Calendar', { exact: true }).selectOption({ label: 'Olivia Owner' });
  await kim.getByText(/Olivia Owner’s calendar: events you add, change or delete here are theirs/).waitFor();
  if (await kim.getByRole('button', { name: 'Booking pages' }).count()) throw new Error('her own tools shown');
  await kim.getByRole('button', { name: 'Create' }).click();
  const dlg = kim.getByRole('dialog', { name: 'New event' });
  await dlg.getByLabel('Title').fill('Investor call');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  await until(async () => (await evs(page)).includes('Investor call'));
  if ((await evs(kim)).includes('Investor call')) throw new Error('on Kim’s own calendar');
  await until(async () => JSON.stringify((await api(page, 'GET', '/notifications')).body).includes('Kim Park added “Investor call” on your calendar'));
});
await step('Kim changes it there; back on her own calendar it isn’t shown', async () => {
  await kim.reload();
  await kim.getByText(/Olivia Owner’s calendar/).waitFor(); // kept for the tab
  await kim.getByText('Investor call', { exact: true }).first().click();
  const dlg = kim.getByRole('dialog').filter({ has: kim.getByLabel('Title') });
  await dlg.getByLabel('Title').fill('Investor call (moved to Zoom)');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await until(async () => (await evs(page)).includes('Investor call (moved to Zoom)'));
  await kim.getByLabel('Calendar', { exact: true }).selectOption({ label: 'My calendar' });
  await kim.getByRole('button', { name: 'Booking pages' }).waitFor();
  await kim.waitForTimeout(500);
  if (await kim.getByText(/^Investor call/).count()) throw new Error('shown on her own');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
