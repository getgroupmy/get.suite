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
const cell = (p, k) => p.locator(`.grid td[data-k="${k}"]`);
let sheet;
await step('a spreadsheet downloads as OpenDocument (.ods)', async () => {
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Team budget', content: { sheets: [
    { name: 'Costs', colWidths: { A: 160 }, cells: { A1: 'Item', B1: 'Cost', A2: 'Laptops', B2: '2400', A3: 'Chairs', B3: '600', A4: 'Total', B4: '=SUM(B2:B3)' }, formats: { A4: { b: 1 }, B4: { b: 1 } } },
    { name: 'Summary', colWidths: {}, cells: { A1: 'Twice the total', B1: '=Costs!B4*2' } },
  ] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell(page, 'B4').filter({ hasText: '3000' }).waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as OpenDocument (.ods)' }).click()]);
  if (dl.suggestedFilename() !== 'Team budget.ods') throw new Error(dl.suggestedFilename());
  const fs = await import('node:fs');
  const bytes = fs.readFileSync(await dl.path());
  if (bytes.subarray(30, 84).toString() !== 'mimetypeapplication/vnd.oasis.opendocument.spreadsheet') throw new Error('not an .ods');
  await page.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); await fetch('/api/files/upload?name=Team%20budget%20(Calc).ods', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bin }); }, bytes.toString('base64'));
});
await step('in Drive an .ods file shows as a spreadsheet and opens as one, its formulas working', async () => {
  await page.goto(`${B}/drive`);
  await page.getByText('Team budget (Calc).ods').dblclick();
  const pv = page.getByRole('dialog').filter({ hasText: 'Team budget (Calc).ods' });
  await pv.getByText('Laptops').waitFor({ timeout: 20000 });
  await pv.getByText('3000').first().waitFor();
  await page.screenshot({ path: `${SP}/shots/ods-preview.png` });
  await pv.getByRole('button', { name: 'Open as spreadsheet' }).click();
  await page.waitForURL(/\/sheets\//);
  await cell(page, 'B4').filter({ hasText: '3000' }).waitFor();
  await page.getByRole('tab', { name: 'Summary' }).or(page.getByRole('button', { name: 'Summary', exact: true })).first().click();
  await cell(page, 'B1').filter({ hasText: '6000' }).waitFor();
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
