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
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const raw = async (id) => (await api(page, 'GET', `/files/${id}/content`)).body.content.sheets[0].cells;
let sheet;
const dlg = () => page.getByRole('dialog', { name: 'Cleanup suggestions' });
await step('Cleanup suggestions list what is untidy; fixing one at a time', async () => {
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Leads', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: {
    A1: 'Region', B1: 'Rep', C1: 'Sales',
    A2: 'North', B2: 'Ann', C2: '10', A3: 'north', B3: ' Ben  Smith ', C3: '20', A4: 'NORTH', B4: 'Cy', C4: '30',
    A5: 'South', B5: 'Ann', C5: '=C2*2', A6: 'North', B6: 'Ann', C6: '10', A7: 'south', B7: 'Dee', C7: '5' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('A2').waitFor();
  await cell('B3').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Cleanup suggestions…' }).click();
  await dlg().getByText('Looking at A1:C7').waitFor();
  if (!(await dlg().getByLabel('The first row has headings (left alone)').isChecked())) throw new Error('headings not guessed');
  await dlg().getByText('Extra spaces').waitFor();
  await dlg().getByText('Column A: the same value written differently').waitFor();
  await dlg().getByText('“North”, “north”, “NORTH” → “North”').waitFor();
  await dlg().getByText('1 row the same as one above').waitFor();
  await page.screenshot({ path: `${SP}/shots/cleanup.png` });
  await dlg().getByRole('button', { name: 'Fix column A' }).click();
  await page.getByText('Column A: 3 cells made the same').waitFor();
  await until(async () => { const c = await raw(sheet.id); return c.A3 === 'North' && c.A4 === 'North' && c.A7 === 'South' && c.A1 === 'Region'; }, 15000);
  if (await dlg().getByText('Column A: the same value written differently').count()) throw new Error('still suggested');
});
await step('Fix all: spaces tidied, then duplicate rows removed; then nothing left to tidy', async () => {
  await dlg().getByRole('button', { name: 'Fix all' }).click();
  await dlg().getByText('✓ Nothing to tidy here.').waitFor();
  const c = await until(async () => { const x = await raw(sheet.id); return x.B3 === 'Ben Smith' && !x.A7 ? x : null; }, 15000);
  if (c.C5 !== '=C2*2' || c.A6 !== 'South') throw new Error(JSON.stringify(c)); // row 6 (a repeat of row 2) went; the rows below moved up
  await dlg().getByRole('button', { name: 'Close' }).last().click();
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
