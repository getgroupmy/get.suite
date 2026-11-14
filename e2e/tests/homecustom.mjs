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
const sec = (name) => page.getByRole('region', { name });
const order = () => page.evaluate(() => [...document.querySelectorAll('.home-grid > section')].filter((s) => !s.hidden).sort((a, b) => Number(a.style.order) - Number(b.style.order)).map((s) => s.dataset.card));
await step('Customize: hide a card and move another to the front; kept after reloading', async () => {
  await page.goto(`${B}/home`);
  await sec('Recent files').waitFor();
  const before = await order();
  if (before[0] !== 'events' || !before.includes('recent')) throw new Error(before.join());
  await page.getByRole('button', { name: 'Customize' }).click();
  const d = page.getByRole('dialog', { name: 'Customize Home' });
  await d.getByRole('checkbox', { name: 'Tasks for today' }).uncheck();
  for (let i = 0; i < 7; i++) await d.getByRole('button', { name: 'Move Recent files up' }).click();
  await page.screenshot({ path: `${SP}/shots/homecustom.png` });
  await d.getByRole('button', { name: 'Done' }).click();
  await until(async () => { const o = await order(); return o[0] === 'recent' && !o.includes('tasks'); });
  if (await sec('Tasks due').isVisible()) throw new Error('tasks still showing');
  await until(async () => (await api(page, 'GET', '/auth/me')).body.user.home_layout.hidden.includes('tasks'));
  await page.reload();
  await sec('Recent files').waitFor();
  const after = await order();
  if (after[0] !== 'recent' || after.includes('tasks')) throw new Error(after.join());
});
await step('Reset puts everything back', async () => {
  await page.getByRole('button', { name: 'Customize' }).click();
  await page.getByRole('dialog', { name: 'Customize Home' }).getByRole('button', { name: 'Reset' }).click();
  await page.getByRole('dialog', { name: 'Customize Home' }).getByRole('button', { name: 'Done' }).click();
  await until(async () => { const o = await order(); return o[0] === 'events' && o.includes('tasks'); });
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
