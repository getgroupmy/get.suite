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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Sales', content: { sheets: [{ name: 'Data', colWidths: {}, cells: { D1: 'Date', D2: '2026-01-15', D3: '2026-01-20', D4: '2026-02-03', D5: '2026-04-11',
    A1: 'Region', B1: 'Product', C1: 'Sales', A2: 'North', B2: 'Tea', C2: '10', A3: 'South', B3: 'Tea', C3: '5', A4: 'North', B4: 'Coffee', C4: '7', A5: 'North', B5: 'Tea', C5: '=1+2' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
});
await step('pivot: by month, two values, a filter, sorted largest first, as % of the total', async () => {
  await cell('B3').click();
  await page.getByRole('button', { name: 'Pivot table' }).click();
  const d = page.getByRole('dialog', { name: 'Pivot table' });
  await d.getByLabel('Rows: one for each').selectOption({ label: 'Date' });
  await d.getByLabel('Dates in it').selectOption('month');
  await d.getByLabel('Values').selectOption({ label: 'Sales' });
  await d.getByLabel('Summarise by').selectOption('sum');
  await d.getByRole('button', { name: '+ Add a value' }).click();
  await d.getByLabel('Value 2', { exact: true }).selectOption('');
  await d.getByLabel('Filter column').selectOption({ label: 'Product' });
  await d.getByRole('list', { name: 'Rows to keep' }).getByLabel(/Coffee/).uncheck();
  await d.getByLabel('Order rows').selectOption('desc');
  await d.getByRole('button', { name: 'Create' }).click();
  // Tea only: Jan 10+5, Apr 3 (=1+2). Sorted by the sum, largest first.
  await until(async () => (await cell('A2').innerText()) === '2026-01');
  const got = [];
  for (const k of ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3', 'A4', 'B4']) got.push((await cell(k).innerText()).trim());
  if (got.join('|') !== 'Date|Sum of Sales|Count of rows|2026-01|15|2|2026-04|3|1|Grand total|18') throw new Error(got.join('|'));
  await page.screenshot({ path: `${SP}/shots/pivot2.png` });
  // As shares of the total.
  await page.getByRole('button', { name: 'Edit pivot table' }).click();
  await page.getByRole('dialog', { name: 'Edit pivot table' }).getByLabel('Show as').selectOption('percent');
  await page.getByRole('button', { name: 'Save' }).click();
  await until(async () => (await cell('B2').innerText()).trim() === '83.3%');
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
