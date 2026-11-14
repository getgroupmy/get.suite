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
await step('setup: Kim has a private meeting today', async () => {
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
  const d = new Date(); const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10).getTime();
  await api(kim, 'POST', '/events', { title: 'Salary review', start, end: start + 36e5 });
});
await step('add Kim: her busy time shows in the day view, without the title', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Day' }).click();
  const pick = page.locator('select.dm-pick');
  await until(async () => (await pick.locator('option').allInnerTexts()).includes('Kim Park'));
  await pick.selectOption({ label: 'Kim Park' });
  const block = page.locator('.tg-busy', { hasText: 'Kim Park' });
  await block.waitFor();
  if (/Salary/.test(await page.locator('.timegrid, .tg-scroll').first().innerText())) throw new Error('title leaked');
  const title = await block.getAttribute('title');
  if (!/Kim Park is busy 10:00/.test(title)) throw new Error(title);
  await block.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SP}/shots/busy.png` });
});
await step('kept after reload; a new meeting of hers appears; hide her', async () => {
  await page.reload();
  await page.locator('.tg-busy', { hasText: 'Kim Park' }).first().waitFor();
  const d = new Date(); const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 15).getTime();
  await api(kim, 'POST', '/events', { title: 'Dentist', start, end: start + 18e5 });
  await page.getByRole('radio', { name: 'Week' }).click();
  await page.getByRole('radio', { name: 'Day' }).click();
  await until(async () => (await page.locator('.tg-busy').count()) === 2);
  await page.getByRole('button', { name: 'Hide Kim Park' }).click();
  await until(async () => (await page.locator('.tg-busy').count()) === 0);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
