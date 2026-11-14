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
await step('hide weekends: the week shows Monday to Friday, the month five columns', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Week' }).click();
  await page.locator('.cal-main').getByText(/Sat|Sun/).first().waitFor();
  await page.getByLabel('Show weekends').uncheck();
  await page.waitForTimeout(500);
  await until(async () => (await page.locator('.cal-main').getByText(/^(Sat|Sun)/).count()) === 0);
  await page.getByRole('radio', { name: 'Month' }).click();
  await until(async () => (await page.locator('.month .dow').allTextContents()).join(',') === 'Mon,Tue,Wed,Thu,Fri');
  const days = await page.locator('.month .day').count();
  if (days !== 30) throw new Error('weekdays of six weeks: ' + days);
  await page.screenshot({ path: `${SP}/shots/noweekends.png` });
});
await step('week numbers on each row of the month and in the week title; remembered', async () => {
  await page.getByLabel('Show week numbers').check();
  await page.locator('.month .weeknum').first().waitFor();
  if (await page.locator('.month .weeknum').count() !== 6) throw new Error('one per row');
  await page.getByRole('radio', { name: 'Week' }).click();
  await page.getByRole('heading', { level: 1 }).getByText(/· Week \d+/).waitFor();
  await page.reload();
  if (await page.getByLabel('Show weekends').isChecked()) throw new Error('weekends choice kept');
  if (!(await page.getByLabel('Show week numbers').isChecked())) throw new Error('week numbers kept');
  await page.getByLabel('Show weekends').check();
  await page.locator('.cal-main').getByText(/Sat|Sun/).first().waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
