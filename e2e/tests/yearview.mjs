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
const y = new Date().getFullYear();
const at = (m, d, h) => new Date(y, m, d, h).getTime();
await step('Year view: twelve months, busy days marked, a click opens the day', async () => {
  for (const [title, s, e] of [['Board meeting', at(2, 10, 9), at(2, 10, 10)], ['Audit', at(2, 10, 14), at(2, 10, 15)], ['Summer party', at(6, 4, 18), at(6, 4, 22)]]) {
    const r = await api(page, 'POST', '/events', { title, start: s, end: e, all_day: 0, color: '#1a73e8' });
    if (r.status !== 201 && r.status !== 200) throw new Error(JSON.stringify(r.body));
  }
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Year' }).click();
  await page.getByRole('heading', { name: String(y), level: 1 }).waitFor();
  if (await page.locator('.year-month').count() !== 12) throw new Error('twelve months');
  const march10 = page.getByRole('button', { name: new RegExp(`March 10, 2 events`) });
  await march10.waitFor();
  if (!/busy-2/.test(await march10.getAttribute('class'))) throw new Error('two events: darker');
  await page.getByRole('button', { name: /July 4, 1 event$/ }).waitFor();
  await page.screenshot({ path: `${SP}/shots/yearview.png` });
  await march10.click();
  await page.getByText('Board meeting').first().waitFor();
  if ((await page.getByRole('radio', { name: 'Day' }).getAttribute('aria-checked')) !== 'true') throw new Error('day view');
});
await step('the arrows move a year; the choice is remembered', async () => {
  await page.getByRole('radio', { name: 'Year' }).click();
  await page.getByRole('button', { name: 'Next year' }).click();
  await page.getByRole('heading', { name: String(y + 1), level: 1 }).waitFor();
  if (await page.locator('.year-day.busy').count()) throw new Error('nothing next year');
  await page.reload();
  await page.getByRole('radio', { name: 'Year', checked: true }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
