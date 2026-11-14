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
let weekStart;
const dlg = () => page.getByRole('dialog', { name: 'Copy this week' });
const range = async (from, days = 7) => (await api(page, 'GET', `/events?from=${from}&to=${from + days * 864e5}`)).body;
await step('this week: two one-off events of mine and a repeating one', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Week' }).click();
  // The week shown starts on its first day (Sunday by default), at local midnight.
  weekStart = await page.evaluate(() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay()); return d.getTime(); });
  const at = (day, h) => weekStart + day * 864e5 + h * 3600e3;
  for (const [title, day, h, rrule] of [['Planning', 1, 10], ['Gym', 3, 18], ['Weekly sync', 2, 9, { freq: 'weekly' }]]) {
    const r = await api(page, 'POST', '/events', { title, start: at(day, h), end: at(day, h + 1), tz: 'UTC', ...(rrule && { rrule }) });
    if (r.status !== 201) throw new Error(JSON.stringify(r));
  }
  await page.reload();
  await page.getByText('Planning').first().waitFor();
});
let copiedIds;
await step('Copy this week… to next week and the one after: the copies are there; Undo takes them away', async () => {
  await page.getByRole('button', { name: 'Copy this week…' }).click();
  await dlg().getByRole('checkbox', { name: /In 2 weeks/ }).check();
  await page.screenshot({ path: `${SP}/shots/copy-week.png` });
  await dlg().getByRole('button', { name: 'Copy' }).click();
  await page.getByText(/^Copied 2 events to 2 weeks/).waitFor();
  const next = (await range(weekStart + 7 * 864e5, 14)).filter((e) => !e.rrule).map((e) => e.title).sort();
  if (next.join() !== 'Gym,Gym,Planning,Planning') throw new Error(next.join());
  await page.getByRole('button', { name: 'Next week' }).click();
  await page.getByText('Planning').first().waitFor();
  await page.getByRole('button', { name: 'Undo' }).click();
  const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)); } };
  await until(async () => (await range(weekStart + 7 * 864e5, 14)).filter((e) => !e.rrule).length === 0);
});
await step('an empty week says so', async () => {
  await page.getByRole('button', { name: 'Next week' }).click();
  await page.getByRole('button', { name: 'Next week' }).click();
  await page.getByRole('button', { name: 'Copy this week…' }).click();
  await dlg().getByRole('button', { name: 'Copy' }).click();
  await page.getByText('Nothing to copy: no one-off events of yours this week').waitFor();
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
