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
let work, home;
await step('lists with tasks, some ticked off', async () => {
  work = (await api(page, 'POST', '/tasks/lists', { name: 'Work' })).body.id;
  home = (await api(page, 'POST', '/tasks/lists', { name: 'Home' })).body.id;
  for (const [l, title] of [[work, 'Send report'], [home, 'Water plants'], [home, 'Still open']]) await api(page, 'POST', `/tasks/lists/${l}/tasks`, { title });
  await page.goto(`${B}/tasks/${work}`);
  await task(page, 'Send report').getByRole('checkbox').first().click();
  await page.goto(`${B}/tasks/${home}`);
  await task(page, 'Water plants').getByRole('checkbox').first().click();
  await until(async () => (await api(page, 'GET', '/tasks/completed')).body.length === 2);
});
await step('the Completed view lists them under Today, with their lists', async () => {
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await page.waitForURL(/\/tasks\/completed$/);
  await page.getByRole('heading', { name: 'Completed' }).first().waitFor();
  const today = page.getByRole('region', { name: 'Today' });
  await until(async () => (await today.locator('.task-title').allInnerTexts()).join('|') === 'Water plants|Send report');
  await task(page, 'Send report').getByText('Work').waitFor();
  if (await page.getByText('Still open').count()) throw new Error('open task shown');
  await page.getByText('2 tasks done in the last 30 days').waitFor();
  await page.screenshot({ path: `${SP}/shots/taskdone.png` });
});
await step('Last 7 days or 30 days, remembered on this device', async () => {
  await page.getByLabel('Completed in').selectOption('7');
  await page.getByText('2 tasks done in the last 7 days').waitFor();
  await page.reload();
  await page.getByText('2 tasks done in the last 7 days').waitFor();
  if ((await page.getByLabel('Completed in').inputValue()) !== '7') throw new Error('not kept');
  await page.getByLabel('Completed in').selectOption('30');
  await page.getByText('2 tasks done in the last 30 days').waitFor();
});
await step('unticking one takes it off', async () => {
  await task(page, 'Send report').getByRole('checkbox').first().click();
  await until(async () => (await page.locator('.task-title').allInnerTexts()).join('|') === 'Water plants');
});
await step('empty view when nothing is done', async () => {
  await task(page, 'Water plants').getByRole('checkbox').first().click();
  await page.getByText('Nothing completed lately').waitFor();
});
console.log(errors.length ? `ERRORS ${errors.join(' / ')}` : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
