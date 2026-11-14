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
import { DatabaseSync } from 'node:sqlite';
const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
await step('a colleague signs in today; earlier days are recorded too (as if the report had been running)', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  const db = new DatabaseSync(`${SP}/data/workspace.db`);
  const ids = db.prepare('SELECT id FROM users ORDER BY created_at').all().map((u) => u.id);
  for (const [n, who] of [[3, ids], [5, ids.slice(0, 1)], [6, ids]]) for (const id of who) db.prepare('INSERT OR IGNORE INTO active_days (user_id, day) VALUES (?, ?)').run(id, day(n));
  db.close();
});
await step('Admin → Reports shows active people per day, with a summary', async () => {
  await page.goto(`${B}/admin?tab=reports`);
  await page.getByLabel('Period').selectOption('7');
  const chart = page.getByRole('region', { name: 'Active people per day' });
  await chart.getByText(/On average 1\.0 of 2 a day; busiest on .* \(2\)\./).waitFor();
  await chart.getByText('Days are in UTC.', { exact: false }).waitFor();
  if (await chart.locator('path.bar').count() !== 4) throw new Error(`bars: ${await chart.locator('path.bar').count()}`);
  await page.screenshot({ path: `${SP}/shots/report-active.png` });
});
await step('pointing at a day shows its count; the table view lists every day', async () => {
  const chart = page.getByRole('region', { name: 'Active people per day' });
  await chart.locator(`g[data-day="${day(5)}"] rect.hit`).hover();
  await chart.getByRole('tooltip').getByText('1 person').waitFor();
  await chart.locator(`g[data-day="${day(0)}"] rect.hit`).hover();
  await chart.getByRole('tooltip').getByText('2 people').waitFor();
  await chart.getByRole('button', { name: 'Show as table' }).click();
  const table = chart.getByRole('table', { name: 'Active people per day' });
  if (await table.locator('tbody tr').count() !== 8) throw new Error('eight days');
  await table.locator('tbody tr').nth(3).getByText('2').waitFor(); // three days ago
  await chart.getByRole('button', { name: 'Show chart' }).click();
  await chart.locator('svg').waitFor();
});
await step('on 30 days, the days before recording began are marked, not counted', async () => {
  await page.getByLabel('Period').selectOption('30');
  const chart = page.getByRole('region', { name: 'Active people per day' });
  await chart.getByText(/Counted from .*, when this report started recording\./).waitFor();
  if (await chart.locator('line.uncounted').count() < 20) throw new Error('uncounted days');
  await chart.getByText(/On average 1\.0 of 2 a day/).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
