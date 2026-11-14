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
const csv = 'First name,Last name,Email,Password,Admin\nKim,Park,kim,,\nLee,Chan,lee@acme.com,leepassword1,yes\nBad,Domain,x@elsewhere.example,,\n';
await step('Import from CSV: the file is checked row by row', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('button', { name: 'Import from CSV' }).click();
  const dlg = page.getByRole('dialog', { name: 'Import users' });
  await dlg.getByLabel('CSV file of users').setInputFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await dlg.getByText('people.csv').waitFor();
  await dlg.getByRole('button', { name: 'Check' }).click();
  await dlg.getByText('elsewhere.example is not a domain of this company').waitFor();
  await dlg.getByRole('cell', { name: 'kim@acme.com' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/import-check.png` });
});
let kimPassword;
await step('Create 2 users: a password is made up for Kim and shown once; the list has them', async () => {
  const dlg = page.getByRole('dialog', { name: 'Import users' });
  await dlg.getByRole('button', { name: 'Create 2 users' }).click();
  await page.getByText('2 users created').waitFor();
  kimPassword = await dlg.locator('tr', { hasText: 'kim@acme.com' }).locator('code').innerText();
  if (!/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/.test(kimPassword)) throw new Error(kimPassword);
  await dlg.locator('tr', { hasText: 'lee@acme.com' }).getByText('from the file').waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: /Download sign-in details/ }).click()]);
  const text = await (await import('node:fs')).promises.readFile(await dl.path(), 'utf8');
  if (!text.includes(`"Kim Park","kim@acme.com","${kimPassword}"`)) throw new Error(text);
  await dlg.getByRole('button', { name: 'Done' }).first().click();
  await page.getByText('kim@acme.com').first().waitFor();
});
await step('Kim signs in with the made-up password, then chooses her own', async () => {
  const kim = await mk('kim');
  await kim.goto(B);
  await kim.getByLabel('Email address').fill('kim@acme.com');
  await kim.getByLabel('Password').fill(kimPassword);
  await kim.getByRole('button', { name: 'Sign in' }).click();
  await kim.getByRole('heading', { name: 'Choose your own password' }).waitFor();
  await kim.getByLabel('Password you were given').fill(kimPassword);
  await kim.getByLabel('New password', { exact: true }).fill('kims-own-secret');
  await kim.getByLabel('New password again').fill('kims-own-secret');
  await kim.getByRole('button', { name: 'Save and continue' }).click();
  await kim.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
