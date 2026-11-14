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
let sheetId;
const cell = (k) => page.locator(`[data-k="${k}"]`);
const typeIn = async (k, text) => { await cell(k).click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
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
  const cells = { A1: 'Month', B1: 'North', C1: 'South', A2: 'Jan', B2: '10', C2: '4', A3: 'Feb', B3: '12', C3: '5', A4: 'Mar', B4: '9', C4: '7', E1: 'Height', F1: 'Weight', E2: '150', F2: '50', E3: '160', F3: '58', E4: '172', F4: '70', E5: '181', F5: '79' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Numbers', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell('F5').getByText('79').waitFor();
});
const JSZip = (await import('module')).createRequire(`${ROOT}/server/package.json`)('jszip');
const insert = async (range, label, title) => {
  await page.getByRole('button', { name: 'Insert chart' }).click();
  const dlg = page.getByRole('dialog', { name: 'Insert chart' });
  await dlg.getByLabel('Cells').fill(range);
  await dlg.locator('.chart-types label', { hasText: new RegExp(`^${label}$`) }).click();
  await dlg.getByLabel('Title').fill(title);
  return dlg;
};
await step('a chart on the sheet goes into the Excel download', async () => {
  await cell('B3').click();
  const dlg = await insert('A1:C4', 'Stacked column', 'Sales by region');
  await dlg.getByRole('button', { name: 'Insert' }).click();
  await page.getByRole('region', { name: 'Chart: Sales by region' }).waitFor();
  await page.waitForTimeout(1200); // saved
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as Excel (.xlsx)' }).click()]);
  const file = `${SP}/charts-dl.xlsx`;
  await dl.saveAs(file);
  const zip = await JSZip.loadAsync((await import('node:fs')).readFileSync(file));
  const chart = await zip.file('xl/charts/chart1.xml')?.async('string');
  if (!chart) throw new Error('no chart in the file: ' + Object.keys(zip.files).join(','));
  if (!/Sales by region/.test(chart) || !/<c:grouping val="stacked"\/>/.test(chart) || !/'Sheet1'!\$B\$2:\$B\$4/.test(chart)) throw new Error(chart.slice(0, 400));
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
