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
let kim, doc;
await step('setup: Olivia has a spreadsheet; Kim has its link but no access', async () => {
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
  doc = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Payroll' })).body;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
await step('Kim opens the link: a page to ask for access, which says nothing about the file', async () => {
  await kim.goto(`${B}/sheets/${doc.id}`);
  await kim.getByRole('heading', { name: 'You need access' }).waitFor();
  if (!kim.url().endsWith(`/access/${doc.id}`)) throw new Error(kim.url());
  if (await kim.getByText('Payroll').count()) throw new Error('name shown');
  await kim.getByLabel('Access to ask for').selectOption('editor');
  await kim.getByLabel('Message (optional)').fill('For the April run');
  await kim.getByRole('button', { name: 'Request access' }).click();
  await kim.getByText('Your request was sent.').waitFor();
  await kim.screenshot({ path: `${SP}/shots/request-access.png` });
});
await step('Olivia is told; Access requests in Drive; she shares it for viewing', async () => {
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: /^Access requests/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Access requests' });
  await dlg.getByText('For the April run').waitFor();
  await dlg.getByText('asks to edit').waitFor();
  await dlg.getByLabel('Access for Kim Park').selectOption('viewer');
  await page.screenshot({ path: `${SP}/shots/access-requests.png` });
  await dlg.getByRole('button', { name: 'Share' }).click();
  await page.getByText('Kim Park can now view Payroll').waitFor();
  await dlg.getByText('Nobody is waiting.').waitFor();
});
await step('Kim can now open it (read only)', async () => {
  await kim.goto(`${B}/sheets/${doc.id}`);
  await kim.waitForFunction(() => document.title.startsWith('Payroll'));
  await kim.locator('.grid').waitFor();
  if (!kim.url().includes(`/sheets/${doc.id}`)) throw new Error(kim.url());
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
