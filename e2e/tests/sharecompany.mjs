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
const row = (p, n) => p.locator('.files tbody tr', { hasText: n }).first();
let kim;
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
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
await step('Olivia shares a folder with everyone in the company from the Share window', async () => {
  const folder = (await api(page, 'POST', '/files/folder', { name: 'Company handbook' })).body;
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Holidays policy', parent_id: folder.id });
  await page.goto(`${B}/drive`);
  await row(page, 'Company handbook').getByRole('button', { name: 'Actions for Company handbook' }).click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  const dlg = page.getByRole('dialog', { name: 'Share “Company handbook”' });
  await dlg.getByLabel('Access for everyone at Acme Trading').selectOption('viewer');
  await page.getByText('Everyone at Acme Trading can view it').waitFor();
  await page.screenshot({ path: `${SP}/shots/share-company.png` });
  await dlg.getByRole('button', { name: 'Cancel' }).click();
});
await step('Kim finds it in Shared with me and can open what is inside, read only', async () => {
  await kim.goto(`${B}/drive/shared`);
  await row(kim, 'Company handbook').dblclick();
  await row(kim, 'Holidays policy').dblclick();
  await kim.waitForURL(/\/docs\//);
  await kim.getByText(/^View only/).waitFor();
});
await step('back to No access: gone for Kim', async () => {
  await page.goto(`${B}/drive`);
  await row(page, 'Company handbook').getByRole('button', { name: 'Actions for Company handbook' }).click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  await page.getByLabel('Access for everyone at Acme Trading').selectOption('');
  await page.getByText('No longer shared with everyone at Acme Trading').waitFor();
  await kim.goto(`${B}/drive/shared`);
  await kim.getByText(/Nothing|No files|shared with you/i).first().waitFor();
  if (await row(kim, 'Company handbook').count()) throw new Error('still there');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
