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
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = new Date();
const dayName = today.toLocaleDateString('en-US', { weekday: 'long' });
let kim;
await step('usual week in Settings', async () => {
  await page.goto(`${B}/settings`);
  const sec = page.getByRole('region', { name: 'Working location' });
  for (const d of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) await sec.getByLabel(d).selectOption('office');
  await sec.getByLabel(dayName).selectOption('home');
  await until(async () => (await api(page, 'GET', `/location?from=${iso(today)}&to=${iso(today)}`)).body.days[iso(today)]?.place === 'home');
});
await step('Calendar shows it above each day; change today to somewhere else', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Week' }).click();
  const row = page.getByRole('group', { name: 'Working location' });
  await row.getByRole('button', { name: /: 🏠 Home$/ }).click();
  await page.getByRole('menuitem', { name: '📍 Elsewhere…' }).click();
  await page.getByLabel('Where?').fill('Client site');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await row.getByRole('button', { name: /: 📍 Client site$/ }).waitFor();
  const r = (await api(page, 'GET', `/location?from=${iso(today)}&to=${iso(today)}`)).body.days[iso(today)];
  if (r.place !== 'other' || r.label !== 'Client site') throw new Error(JSON.stringify(r));
});
await step('colleagues see it in the Directory', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/contacts`);
  await kim.getByRole('tab', { name: /Directory/ }).click().catch(async () => { await kim.getByRole('button', { name: /Directory/ }).click(); });
  await kim.getByText('📍 Client site today').waitFor();
});
await step('Home says it; back to the usual week', async () => {
  await page.goto(`${B}/home`);
  await page.getByText(/📍 Client site today/).waitFor();
  await page.goto(`${B}/calendar`);
  const row = page.getByRole('group', { name: 'Working location' });
  await row.getByRole('button', { name: /: 📍 Client site$/ }).click();
  await page.getByRole('menuitem', { name: 'Back to my usual week' }).click();
  await row.getByRole('button', { name: /: 🏠 Home$/ }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
