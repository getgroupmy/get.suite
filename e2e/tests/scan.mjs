import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
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
const fsx = await import('node:fs');
const D = `${ROOT}/web/src/apps/drive`;
await step('scan two pages on a phone into one PDF in Drive', async () => {
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Scan to PDF…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Scan to PDF' });
  await dlg.getByLabel('Photo of a page').setInputFiles({ name: 'p1.jpg', mimeType: 'image/jpeg', buffer: fsx.readFileSync(`${D}/testdata-receipt-portrait.jpg`) });
  await dlg.getByRole('img', { name: 'Page 1' }).waitFor();
  await dlg.getByLabel('Photo of a page').setInputFiles({ name: 'p2.jpg', mimeType: 'image/jpeg', buffer: fsx.readFileSync(`${D}/testdata-receipt-landscape.jpg`) });
  await dlg.getByRole('img', { name: 'Page 2' }).waitFor();
  await dlg.getByRole('button', { name: 'Move page 2 earlier' }).click(); // the landscape one first
  await dlg.getByLabel('Name').fill('Receipts March');
  await dlg.getByRole('button', { name: 'Save PDF (2 pages)' }).click();
  await page.locator('tbody').getByText('Receipts March.pdf').waitFor({ timeout: 15000 });
  const f = (await api(page, 'GET', '/files')).body.find((x) => x.name === 'Receipts March.pdf');
  if (f.mime !== 'application/pdf') throw new Error(f.mime);
  const bytes = await page.evaluate(async (id) => [...new Uint8Array(await (await fetch(`/api/files/${id}/raw`)).arrayBuffer())], f.id);
  const out = `${SP}/scan-out.pdf`;
  fsx.writeFileSync(out, Buffer.from(bytes));
  const { execFileSync } = await import('node:child_process');
  const info = execFileSync('pdfinfo', ['-f', '1', '-l', '2', out], { encoding: 'utf8' });
  if (!/Pages:\s+2/.test(info)) throw new Error(info);
  if (!/Page\s+1 size:\s+595\.28 x 297\.64/.test(info)) throw new Error(`page order: ${info}`);
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
