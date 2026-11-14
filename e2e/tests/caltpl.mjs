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
await step('save the event as a template', async () => {
  const d = page.getByRole('dialog', { name: 'Edit event' });
  await d.getByRole('button', { name: '📋 Template' }).click();
  await page.getByRole('menuitem', { name: 'Save as template…' }).click();
  const n = page.getByRole('dialog', { name: 'Save as template' });
  await n.getByLabel('Template name').fill('Supplier call');
  await n.getByRole('button', { name: 'Save template' }).click();
  await n.waitFor({ state: 'detached' });
  await d.getByRole('button', { name: 'Cancel' }).click();
  const t = (await api(page, 'GET', '/events/templates')).body;
  if (t.length !== 1 || t[0].minutes !== 60 || t[0].location !== 'Room 2' || t[0].guests[0] !== 'kim@acme.com') throw new Error(JSON.stringify(t));
});
await step('From a template opens a new event with its details, at the next hour', async () => {
  await page.getByRole('button', { name: 'From a template…' }).click();
  await page.getByRole('menuitem', { name: 'Supplier call' }).click();
  const c = page.getByRole('dialog', { name: 'New event from “Supplier call”' });
  await c.waitFor();
  if (await c.getByLabel('Title').inputValue() !== 'Supplier call') throw new Error('title');
  await page.screenshot({ path: `${SP}/shots/cal-template.png` });
  await c.getByRole('button', { name: 'Save' }).click();
  await c.waitFor({ state: 'detached' });
  const at = new Date(); at.setMinutes(0, 0, 0); at.setHours(at.getHours() + 1);
  const evs = (await api(page, 'GET', `/events?from=${at.getTime() - 1}&to=${at.getTime() + 2 * 36e5}`)).body.filter((e) => e.title === 'Supplier call');
  if (evs.length !== 1 || evs[0].end - evs[0].start !== 36e5 || evs[0].location !== 'Room 2') throw new Error(JSON.stringify(evs.map((e) => [e.start, e.end, e.location])));
});
await step('Export templates gives a file; Import templates… adds the ones not here (a colleague starts from none)', async () => {
  await page.getByRole('button', { name: 'From a template…' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export templates' }).click()]);
  if (dl.suggestedFilename() !== 'Calendar templates.json') throw new Error(dl.suggestedFilename());
  const buf = (await import('node:fs')).readFileSync(await dl.path());
  const data = JSON.parse(buf.toString());
  if (data.length !== 1 || data[0].name !== 'Supplier call' || 'id' in data[0]) throw new Error(JSON.stringify(data));
  await api(page, 'POST', '/users', { local: 'len', domain: 'acme.com', name: 'Len Lee', password: 'password123' });
  const len = await mk('len'); await signIn(len, 'len@acme.com');
  await len.goto(`${B}/calendar`);
  await len.getByRole('button', { name: 'Templates…' }).click();
  await len.getByRole('menuitem', { name: 'Import templates…' }).waitFor();
  await len.keyboard.press('Escape');
  await len.getByLabel('Import event templates').setInputFiles({ name: 'Calendar templates.json', mimeType: 'application/json', buffer: buf });
  await len.getByText('Added 1 template').waitFor();
  await len.getByRole('button', { name: 'From a template…' }).click();
  await len.getByRole('menuitem', { name: 'Supplier call' }).click();
  await len.getByRole('dialog', { name: 'New event from “Supplier call”' }).waitFor();
  await len.keyboard.press('Escape');
  await len.getByLabel('Import event templates').setInputFiles({ name: 'Calendar templates.json', mimeType: 'application/json', buffer: buf });
  await len.getByText('Those templates are all here already').waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
