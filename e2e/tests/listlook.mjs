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
let list;
await step('give a list a colour and an emoji; it shows in the list nav and the heading', async () => {
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Launch' })).body.id;
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Ship it', due: iso(new Date()) });
  await page.goto(`${B}/tasks/${list}`);
  await page.locator('.task-title', { hasText: 'Ship it' }).waitFor();
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Colour and emoji…' }).click();
  const d = page.getByRole('dialog', { name: 'Colour and emoji for “Launch”' });
  await d.getByRole('radio', { name: 'Blue' }).click();
  await d.getByRole('radio', { name: 'Emoji 🚀' }).click();
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('heading', { name: '🚀 Launch' }).waitFor();
  const nav = page.locator('.subnav-item', { hasText: 'Launch' });
  await nav.locator('.list-emoji', { hasText: '🚀' }).waitFor();
  if (await nav.locator('.list-dot').evaluate((e) => getComputedStyle(e).backgroundColor) !== 'rgb(26, 115, 232)') throw new Error('colour');
});
await step('its tasks carry them in Planned', async () => {
  await page.getByRole('button', { name: /Planned/ }).click();
  const name = page.locator('.task-list-name', { hasText: 'Launch' }).first();
  await name.waitFor();
  if (!(await name.innerText()).includes('🚀')) throw new Error(await name.innerText());
  await page.screenshot({ path: `${SP}/shots/list-look.png` });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
