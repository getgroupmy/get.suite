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
const page = await mk("olivia");
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const saved = () => page.getByText('All changes saved').waitFor({ timeout: 10000 });
let sheet;
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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Sales', content: { sheets: [{ name: 'Data', colWidths: {}, cells: {
    A1: 'Region', B1: 'Product', C1: 'Sales', A2: 'North', B2: 'Tea', C2: '10', A3: 'South', B3: 'Tea', C3: '5', A4: 'North', B4: 'Coffee', C4: '7', A5: 'North', B5: 'Tea', C5: '=1+2' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
});
const content = async () => (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content;
const tab = (name) => page.locator('.sheet-tabs button, .tabs button').filter({ hasText: new RegExp(`^${name}$`) }).first();
await step('make a pivot table from the table around the cursor', async () => {
  await cell('B3').click();
  await page.getByRole('button', { name: 'Pivot table' }).click();
  const d = page.getByRole('dialog', { name: 'Pivot table' });
  await d.getByText('Data!A1:C').waitFor();
  await d.getByLabel('Rows: one for each').selectOption({ label: 'Region' });
  await d.getByLabel('Columns: one for each (optional)').selectOption({ label: 'Product' });
  await d.getByLabel('Values').selectOption({ label: 'Sales' });
  await d.getByLabel('Summarise by').selectOption('sum');
  await d.getByRole('button', { name: 'Create' }).click();
  await page.getByText('Pivot table of').waitFor();
  await until(async () => (await cell('D2').innerText()) === '20');
  const want = { A1: 'Sum of Sales', B1: 'Coffee', C1: 'Tea', D1: 'Grand total', A2: 'North', B2: '7', C2: '13', A3: 'South', C3: '5', A4: 'Grand total', D4: '25' };
  for (const [k, v] of Object.entries(want)) if ((await cell(k).innerText()) !== v) throw new Error(`${k}: ${await cell(k).innerText()}`);
  await until(async () => (await content()).sheets[1]?.pivot?.source === 'Data');
  await page.screenshot({ path: `${SP}/shots/pivot.png` });
});
await step('typing on the pivot sheet is refused', async () => {
  await cell('B5').click();
  await page.keyboard.type('99');
  await page.keyboard.press('Enter');
  await page.getByText('This sheet is a pivot table').first().waitFor();
  if ((await cell('B5').innerText()) !== '') throw new Error('typed into pivot');
});
await step('changing the data (and adding a row) updates it', async () => {
  await page.locator('button', { hasText: /^Data$/ }).first().click();
  await cell('C3').click();
  await page.keyboard.type('15');
  await page.keyboard.press('Enter');
  await cell('A6').click();
  await page.keyboard.type('West'); await page.keyboard.press('Tab');
  await page.keyboard.type('Tea'); await page.keyboard.press('Tab');
  await page.keyboard.type('1'); await page.keyboard.press('Enter');
  await until(async () => { const p = (await content()).sheets[1]; return p.cells.D3 === '15' && p.cells.A4 === 'West' && p.cells.D5 === '36'; });
});
await step('edit the pivot: average, no columns', async () => {
  await page.locator('button', { hasText: /^Pivot table 1$/ }).first().click();
  await page.getByRole('button', { name: 'Edit pivot table' }).click();
  const d = page.getByRole('dialog', { name: 'Edit pivot table' });
  await d.getByLabel('Columns: one for each (optional)').selectOption({ label: 'None' });
  await d.getByLabel('Summarise by').selectOption('average');
  await d.getByRole('button', { name: 'Save' }).click();
  await until(async () => (await cell('B1').innerText()) === 'Average of Sales');
  if ((await cell('A1').innerText()) !== 'Region') throw new Error(await cell('A1').innerText());
  if ((await cell('B2').innerText()) !== '6.666666666667' && !(await cell('B2').innerText()).startsWith('6.66')) throw new Error(await cell('B2').innerText());
});
await step('renaming the data sheet keeps the pivot working', async () => {
  await page.locator('.sheet-tab button', { hasText: /^Data$/ }).click();
  await page.getByRole('button', { name: 'Options for Data' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByLabel('Sheet name').fill('Orders');
  await page.getByRole('button', { name: 'Save' }).click();
  await until(async () => (await content()).sheets[1].pivot.source === 'Orders');
  await cell('C2').click();
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  await until(async () => (await content()).sheets[1].cells.A2 === 'North' && (await content()).sheets[1].cells.B2 === String((20 + 7 + 3) / 3));
});
await step('Excel download has the pivot values', async () => {
  const size = await page.evaluate(async (id) => (await (await fetch(`/api/files/${id}/export`)).arrayBuffer()).byteLength, sheet.id);
  if (size < 1000) throw new Error(`small ${size}`);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
