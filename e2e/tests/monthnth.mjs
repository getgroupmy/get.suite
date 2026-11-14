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
await step('setup: a colleague', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
const view = (n) => page.getByRole('radio', { name: n, exact: true });
const cellWith = (title) => page.locator('.day:not(.other)', { has: page.getByText(title) }).locator('.daynum').allInnerTexts();
await step('monthly on the last Monday, chosen in the event window', async () => {
  await page.goto(B + '/calendar');
  await page.getByRole('button', { name: 'Create' }).click();
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.getByLabel('Title').fill('Month-end review');
  await dlg.getByLabel('Starts').fill('2026-12-28'); // Monday: the fourth and the last of December
  await dlg.getByLabel('Start time').fill('15:00');
  await dlg.getByLabel('End time').fill('16:00');
  const opts = await dlg.getByLabel('Repeat', { exact: true }).locator('option').allInnerTexts();
  for (const o of ['Monthly (same date)', 'Monthly on the fourth Monday', 'Monthly on the last Monday']) if (!opts.includes(o)) throw new Error(opts.join(' / '));
  await dlg.getByLabel('Repeat', { exact: true }).selectOption({ label: 'Monthly on the last Monday' });
  await dlg.getByText('Monthly on the last Monday', { exact: true }).last().waitFor();
  await dlg.getByLabel('Ends').getByLabel('After').check();
  await dlg.getByLabel('Number of times').fill('6');
  await dlg.getByText('Monthly on the last Monday, 6 times').waitFor();
  await dlg.screenshot({ path: `${SP}/shots/cal-monthly-nth.png` });
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  const ev = (await api(page, 'GET', `/events?from=${Date.UTC(2026, 11, 1)}&to=${Date.UTC(2027, 0, 1)}`)).body.find((e) => e.title === 'Month-end review');
  if (ev.rrule.freq !== 'monthly' || ev.rrule.nth !== -1 || ev.rrule.wd !== 1 || ev.rrule.count !== 6) throw new Error(JSON.stringify(ev.rrule));
});
await step('the series lands on each month\'s last Monday', async () => {
  // Month view from December 2026: 28 Dec, 25 Jan, 22 Feb (the last Monday, not the 4th week's), 29 Mar.
  await view('Month').click();
  const now = new Date();
  for (let i = 0; i < (2026 - now.getFullYear()) * 12 + 11 - now.getMonth(); i++) await page.getByRole('button', { name: 'Next month' }).click();
  for (const want of ['28', '25', '22', '29']) {
    await until(async () => (await cellWith('Month-end review')).join() === want);
    await page.getByRole('button', { name: 'Next month' }).click();
  }
});
await step('changing the start re-offers the right choices, and an open event says the rule', async () => {
  await page.getByText('Month-end review').first().click();
  await page.getByText('Monthly on the last Monday, 6 times').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Create' }).click();
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.getByLabel('Starts').fill('2027-01-13'); // the second Wednesday
  await dlg.getByLabel('Repeat', { exact: true }).selectOption({ label: 'Monthly on the second Wednesday' });
  let opts = await dlg.getByLabel('Repeat', { exact: true }).locator('option').allInnerTexts();
  if (opts.some((o) => /last/.test(o))) throw new Error('last offered mid-month: ' + opts.join(' / '));
  await dlg.getByLabel('Starts').fill('2027-01-29'); // the fifth Friday: only "the last"
  opts = await dlg.getByLabel('Repeat', { exact: true }).locator('option').allInnerTexts();
  if (opts.some((o) => /fifth|on the \w+ Friday/.test(o) && !/last/.test(o)) || !opts.includes('Monthly on the last Friday')) throw new Error(opts.join(' / '));
  if ((await dlg.getByLabel('Repeat', { exact: true }).inputValue()) !== 'monthly-last') throw new Error('choice not carried over');
  await dlg.getByText('Monthly on the last Friday', { exact: true }).last().waitFor();
  await dlg.getByRole('button', { name: 'Cancel' }).click();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
