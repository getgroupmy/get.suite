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
const day = 864e5;
const dayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
await step('an event with a place, notes, a guest and a reminder', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const start = dayStart + day + 10 * 36e5;
  const r = await api(page, 'POST', '/events', { title: 'Supplier call', location: 'Room 2', description: 'Prices for 2027', start, end: start + 36e5, guests: ['kim@acme.com'], reminders: [15] });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Month' }).click();
  await page.locator('.month .chip', { hasText: 'Supplier call' }).first().click();
  await page.getByRole('dialog', { name: 'Edit event' }).waitFor();
});
await step('Duplicate opens a copy with everything filled in; move it a day later and save', async () => {
  const d = page.getByRole('dialog', { name: 'Edit event' });
  await d.getByRole('button', { name: 'Duplicate' }).click();
  const c = page.getByRole('dialog', { name: 'Copy of event' });
  await c.waitFor();
  await page.getByText('Duplicated: change what you need, then Save').waitFor();
  if ((await c.getByLabel('Title').inputValue()) !== 'Supplier call') throw new Error('title');
  if ((await c.getByLabel('Location').inputValue()) !== 'Room 2') throw new Error('location');
  if ((await c.getByLabel('Description').inputValue()) !== 'Prices for 2027') throw new Error('notes');
  await c.getByText('Kim Park').first().waitFor();
  const next = new Date(dayStart + 2 * day + 12 * 36e5);
  const ds = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
  const dateInputs = c.locator('input[type=date]');
  await dateInputs.nth(0).fill(ds);
  await dateInputs.nth(1).fill(ds);
  await c.getByRole('button', { name: 'Save' }).click();
  await c.waitFor({ state: 'detached' });
});
await step('two events now; the original unchanged; the copy keeps guest and reminder', async () => {
  const list = (await api(page, 'GET', `/events?from=${dayStart}&to=${dayStart + 7 * day}`)).body.filter((e) => e.title === 'Supplier call').sort((a, b) => a.start - b.start);
  if (list.length !== 2) throw new Error('count ' + list.length);
  const [orig, copy] = list;
  if (copy.start - orig.start !== day) throw new Error('copy a day later');
  if (copy.id === orig.id) throw new Error('same id');
  if (copy.location !== 'Room 2' || copy.guests.map((g) => g.email).join() !== 'kim@acme.com') throw new Error(JSON.stringify(copy));
  if (copy.reminders.join() !== '15') throw new Error('reminders ' + JSON.stringify(copy.reminders));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
