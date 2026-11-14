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
await step('events to find', async () => {
  const now = Date.now();
  const mk = (title, start, extra = {}) => api(page, 'POST', '/events', { title, start, end: start + 36e5, ...extra });
  await mk('Budget review', now + 40 * day, { location: 'Room 4' });
  await mk('Old budget talk', now - 60 * day);
  await mk('Standup', now - 10 * day, { description: 'quick budget check', rrule: { freq: 'daily' } });
  await mk('Lunch', now + day);
  await page.goto(`${B}/calendar`);
  await page.getByLabel('Search events').waitFor();
});
await step('search lists matches, coming first; past ones after', async () => {
  await page.getByLabel('Search events').fill('budget');
  await page.getByLabel('Search events').press('Enter');
  const list = page.getByRole('list', { name: 'Search results' });
  await list.getByText('Budget review').waitFor();
  const titles = await list.locator('strong').allInnerTexts();
  if (titles.join('|') !== 'Standup|Budget review|Old budget talk') throw new Error(titles.join('|'));
  if (!(await list.locator('li', { hasText: 'Budget review' }).innerText()).includes('Room 4')) throw new Error('place shown');
  if (!(await list.locator('li', { hasText: 'Standup' }).innerText()).includes('repeats')) throw new Error('repeats shown');
  await page.screenshot({ path: `${SP}/shots/cal-search.png` });
});
await step('opening a result goes to its day and opens it', async () => {
  await page.getByRole('list', { name: 'Search results' }).getByText('Budget review').click();
  const dlg = page.getByRole('dialog');
  await dlg.waitFor();
  const t = await dlg.locator('input').first().inputValue();
  if (t !== 'Budget review') throw new Error('opened ' + t);
  await page.keyboard.press('Escape');
  const target = new Date(Date.now() + 40 * day);
  const heading = await page.locator('.cal-main h1, .cal-main h2').first().innerText();
  if (!heading.includes(target.toLocaleDateString('en-US', { month: 'long' }))) throw new Error('not at its month: ' + heading);
});
await step('Clear brings back Upcoming; no match says so', async () => {
  await page.getByLabel('Search events').fill('zebra');
  await page.getByLabel('Search events').press('Enter');
  await page.getByText('No events match “zebra”').waitFor();
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.getByText('Upcoming').waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
