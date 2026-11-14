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
await step('Week starts on Monday: month, week and year views follow', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Month' }).click();
  await until(async () => (await page.locator('.month .dow').first().textContent()) === 'Sun');
  await page.getByLabel('Week starts on').selectOption('1');
  await until(async () => (await page.locator('.month .dow').allTextContents()).join(',') === 'Mon,Tue,Wed,Thu,Fri,Sat,Sun');
  const firstDay = await page.locator('.month .day').first().getAttribute('data-day');
  if (new Date(Number(firstDay)).getDay() !== 1) throw new Error('grid starts on a Monday');
  await page.getByRole('radio', { name: 'Week' }).click();
  await until(async () => /^Mon/.test(await page.locator('.tg-dow').first().textContent()));
  await page.getByRole('radio', { name: 'Year' }).click();
  await until(async () => (await page.locator('.year-month').first().locator('.year-dow').allTextContents()).join('') === 'MTWTFSS');
  await page.screenshot({ path: `${SP}/shots/weekstart.png` });
});
await step('Saturday too; remembered after a reload', async () => {
  await page.getByLabel('Week starts on').selectOption('6');
  await page.getByRole('radio', { name: 'Week' }).click();
  await until(async () => /^Sat/.test(await page.locator('.tg-dow').first().textContent()));
  await page.reload();
  if ((await page.getByLabel('Week starts on').inputValue()) !== '6') throw new Error('kept');
  await until(async () => /^Sat/.test(await page.locator('.tg-dow').first().textContent()));
});
await step('printing "This week" starts on the chosen day too', async () => {
  await page.getByRole('button', { name: 'Print or save as PDF' }).click();
  const d = page.getByRole('dialog', { name: 'Print or save as PDF' });
  await d.getByLabel('What to print').selectOption('custom');
  const from = await d.locator('input[type="date"]').first().inputValue();
  await d.getByLabel('What to print').selectOption('week');
  const [y, m, dd] = from.split('-').map(Number);
  if (new Date(y, m - 1, dd).getDay() !== 6) throw new Error('custom dates start from the Saturday: ' + from);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
