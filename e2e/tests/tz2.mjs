import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Europe/London', locale: 'en-GB' });
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
await step('choose a second time zone in Settings', async () => {
  await page.goto(`${B}/settings`);
  await page.getByRole('region', { name: 'Second time zone' }).getByLabel('Also show the time in').selectOption('Asia/Tokyo');
  await page.getByText('Calendar also shows the time in Tokyo').waitFor();
});
await step('the week view shows both times beside the hours', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Week' }).click();
  // 09:00 in London (GMT in November) is 18:00 in Tokyo.
  const label = page.getByLabel(/^Tokyo: 18$|^Tokyo: 18:00$|^Tokyo: 6 pm$/i);
  await label.first().waitFor();
  await page.locator('.tg-zones').getByText(/GMT\+9|JST/).waitFor();
  await page.screenshot({ path: `${SP}/shots/tz2.png` });
});
await step('remove it', async () => {
  await page.goto(`${B}/settings`);
  await page.getByRole('region', { name: 'Second time zone' }).getByLabel('Also show the time in').selectOption('');
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Week' }).click();
  await page.locator('.tg-hour').nth(9).waitFor();
  if (await page.locator('.tg-hour .tz2').count()) throw new Error('still shown');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
