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
const now = new Date();
const thisMonth = (d) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(d)}`;
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
await step('add a contact with a birthday, and one with day and month only', async () => {
  await page.getByRole('link', { name: 'Contacts', exact: true }).click();
  for (const [name, day, noYear] of [['Ann Lee', 12, false], ['Bo Chan', 20, true]]) {
    await page.getByRole('button', { name: /New contact/ }).click();
    const m = page.getByRole('dialog');
    await m.getByLabel('Name').fill(name);
    await m.getByLabel('Birthday').fill(`1990-${pad(now.getMonth() + 1)}-${pad(day)}`);
    if (noYear) await m.getByLabel('Year not known').check();
    await m.getByRole('button', { name: 'Save' }).click();
    await m.waitFor({ state: 'detached' });
  }
  const list = (await api(page, 'GET', '/contacts')).body;
  const got = list.map((c) => `${c.name}=${c.birthday}`).sort().join('|');
  const want = `Ann Lee=1990-${pad(now.getMonth() + 1)}-12|Bo Chan=--${pad(now.getMonth() + 1)}-20`;
  if (got !== want) throw new Error(got);
});
await step('the calendar shows them, with the age when known; clicking opens the contact', async () => {
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  await page.getByRole('radio', { name: 'Month' }).click();
  const age = now.getFullYear() - 1990;
  await page.locator('.birthday-chip', { hasText: `🎂 Ann Lee (${age})` }).waitFor();
  await page.locator('.birthday-chip', { hasText: '🎂 Bo Chan' }).waitFor();
  if ((await page.locator('.birthday-chip', { hasText: 'Bo Chan' }).innerText()).includes('(')) throw new Error('no age without a year');
  const cell = await page.locator('.birthday-chip', { hasText: 'Ann Lee' }).evaluate((el) => el.closest('[data-day]').dataset.day);
  if (new Date(Number(cell)).getDate() !== 12) throw new Error('wrong day');
  await page.screenshot({ path: `${SP}/shots/birthdays.png` });
  await page.locator('.birthday-chip', { hasText: 'Ann Lee' }).click();
  await page.waitForURL(/\/contacts\?q=Ann/);
  await page.locator('tbody tr', { hasText: 'Ann Lee' }).waitFor();
  if ((await page.locator('tbody tr').count()) !== 1) throw new Error('filtered to Ann');
});
await step('the week view shows them in the all-day row; the switch hides them', async () => {
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  await page.evaluate(() => {});
  const list = (await api(page, 'GET', '/contacts')).body;
  await api(page, 'PATCH', `/contacts/${list.find((c) => c.name === 'Ann Lee').id}`, { birthday: `1990-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` });
  await page.getByRole('radio', { name: 'Week' }).click();
  await page.locator('.tg-allday .birthday-chip', { hasText: 'Ann Lee' }).waitFor();
  await page.getByLabel('Show contacts’ birthdays').uncheck();
  await until(async () => (await page.locator('.birthday-chip').count()) === 0);
  await page.reload();
  await page.getByLabel('Show contacts’ birthdays').waitFor();
  if (await page.getByLabel('Show contacts’ birthdays').isChecked()) throw new Error('setting kept');
  await page.getByLabel('Show contacts’ birthdays').check();
  await page.locator('.birthday-chip', { hasText: 'Ann Lee' }).waitFor();
});
await step('editing keeps the birthday; Clear removes it', async () => {
  await page.getByRole('link', { name: 'Contacts', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Bo Chan' }).click();
  const m = page.getByRole('dialog');
  if (!(await m.getByLabel('Year not known').isChecked())) throw new Error('no-year kept');
  await m.getByRole('button', { name: 'Clear' }).click();
  await m.getByRole('button', { name: 'Save' }).click();
  await m.waitFor({ state: 'detached' });
  const bo = (await api(page, 'GET', '/contacts')).body.find((c) => c.name === 'Bo Chan');
  if (bo.birthday !== null) throw new Error('cleared ' + bo.birthday);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
