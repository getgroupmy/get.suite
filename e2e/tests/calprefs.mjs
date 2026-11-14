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
const minutesOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
await step('Calendar settings: 30-minute events, speedy, and two reminders', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Calendar settings' }).click();
  const d = page.getByRole('dialog', { name: 'Calendar settings' });
  await d.getByLabel('Default event length').selectOption('30');
  await d.getByLabel('Speedy meetings').check();
  await d.getByText('New events now last 25 minutes').waitFor();
  await d.getByRole('button', { name: 'Add another reminder' }).click();
  await d.getByLabel('Reminder 2', { exact: true }).selectOption({ label: '1 day before' });
  await page.screenshot({ path: `${SP}/shots/cal-settings.png` });
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Calendar settings saved').waitFor();
  const me = (await api(page, 'GET', '/auth/me')).body.user;
  if (JSON.stringify(me.cal_prefs) !== JSON.stringify({ length: 30, speedy: true, reminders: [10, 1440], declined: true, colorRules: [] })) throw new Error(JSON.stringify(me.cal_prefs));
});
await step('a new event lasts 25 minutes and starts with those reminders (after a reload too)', async () => {
  await page.reload();
  await page.getByRole('button', { name: 'Create' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.waitFor();
  const len = minutesOf(await dlg.getByLabel('End time').inputValue()) - minutesOf(await dlg.getByLabel('Start time').inputValue());
  if (len !== 25) throw new Error(`lasts ${len}`);
  if (await dlg.getByLabel('Reminder 1', { exact: true }).inputValue() !== '10' || await dlg.getByLabel('Reminder 2', { exact: true }).inputValue() !== '1440') throw new Error('reminders');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
