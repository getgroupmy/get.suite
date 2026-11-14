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
const insert = async (range, label, title) => {
  await page.getByRole('button', { name: 'Insert chart' }).click();
  const dlg = page.getByRole('dialog', { name: 'Insert chart' });
  await dlg.getByLabel('Cells').fill(range);
  await dlg.locator('.chart-types label', { hasText: new RegExp(`^${label}$`) }).click();
  await dlg.getByLabel('Title').fill(title);
  return dlg;
};
await step('stacked column: a piece per series, with the total on hover', async () => {
  await cell('B3').click();
  const dlg = await insert('A1:C4', 'Stacked column', 'Stacked');
  await page.waitForTimeout(300);
  if (await dlg.locator('.chart-preview svg rect[fill^="var(--series"]').count() !== 6) throw new Error('pieces: ' + await dlg.locator('.chart-preview svg rect[fill^="var(--series"]').count());
  await page.screenshot({ path: `${SP}/shots/chart-types-dialog.png` });
  await dlg.getByRole('button', { name: 'Insert' }).click();
  const card = page.getByRole('region', { name: 'Chart: Stacked' });
  await card.waitFor();
  const box = await card.locator('svg').boundingBox();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
  await card.locator('.chart-tip', { hasText: 'Feb' }).getByText('Total: 17').waitFor();
});
await step('area, doughnut and scatter charts draw', async () => {
  await page.mouse.move(5, 600); await cell('A20').click();
  let dlg = await insert('A1:C4', 'Area', 'Area');
  await dlg.locator('.chart-preview svg polygon').first().waitFor();
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  dlg = await insert('A1:B4', 'Doughnut', 'Doughnut');
  await dlg.locator('.chart-preview svg').getByText('Total').waitFor();
  await dlg.locator('.chart-preview svg text.chart-total', { hasText: '31' }).waitFor();
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  dlg = await insert('E1:F5', 'Scatter', 'Height and weight');
  await page.waitForTimeout(300);
  if (await dlg.locator('.chart-preview svg circle').count() !== 4) throw new Error('points: ' + await dlg.locator('.chart-preview svg circle').count());
  await dlg.getByRole('button', { name: 'Insert' }).click();
  const card = page.getByRole('region', { name: 'Chart: Height and weight' });
  await card.locator('svg circle').nth(2).hover();
  await card.locator('.chart-tip', { hasText: 'Height: 172' }).getByText('Weight: 70').waitFor();
  await page.screenshot({ path: `${SP}/shots/chart-types.png` });
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
