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
const tomorrowAt = (h) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, 0, 0, 0); return d.getTime(); };
const dayIso = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
await step('rooms with different equipment', async () => {
  for (const [name, capacity, features] of [['Boardroom', 12, ['Video', 'Whiteboard']], ['Huddle', 4, ['Video']], ['Pod', 2, []]]) await api(page, 'POST', '/rooms', { name, capacity, features });
});
await step('in an event, Needs: Whiteboard leaves only the Boardroom; Video adds the Huddle back when Whiteboard is off', async () => {
  const start = tomorrowAt(10);
  await api(page, 'POST', '/events', { title: 'Planning', start, end: start + 36e5 });
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Month' }).click();
  await page.locator('.month .chip', { hasText: 'Planning' }).first().click();
  const d = page.getByRole('dialog', { name: 'Edit event' });
  const opts = async () => (await d.getByLabel('Add a room').locator('option').allInnerTexts()).slice(1).map((o) => o.split(' ')[0]);
  await until(async () => (await opts()).length === 3);
  const needs = d.getByRole('group', { name: 'Room needs' });
  await needs.getByRole('button', { name: 'Whiteboard' }).click();
  await until(async () => (await opts()).join() === 'Boardroom');
  await page.screenshot({ path: `${SP}/shots/roomneeds.png` });
  await needs.getByRole('button', { name: 'Whiteboard' }).click();
  await needs.getByRole('button', { name: 'Video' }).click();
  await until(async () => (await opts()).sort().join() === 'Boardroom,Huddle');
});
await step('Rooms now: the same filter', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Rooms now' }).click();
  const d = page.getByRole('dialog', { name: 'Rooms now' });
  await until(async () => (await d.getByRole('list', { name: 'Rooms' }).getByRole('listitem').count()) === 3);
  await d.getByRole('group', { name: 'Room needs' }).getByRole('button', { name: 'Whiteboard' }).click();
  await until(async () => (await d.getByRole('list', { name: 'Rooms' }).getByRole('listitem').count()) === 1);
  await d.getByRole('listitem', { name: 'Boardroom' }).waitFor();
});
console.log(errors.length ? `ERRORS ${errors.join(' / ')}` : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
