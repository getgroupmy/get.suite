import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed/.test(m.text()) && errors.push(m.text()));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await page.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const text = async (k) => (await cell(k).innerText()).trim();
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const expectCells = async (want) => { for (const [k, v] of Object.entries(want)) { const t = await text(k); if (t !== v) throw new Error(`${k}: "${t}" not "${v}"`); } };
const typeIn = async (k, s) => { await cell(k).click(); await page.keyboard.type(s); await page.keyboard.press('Enter'); };
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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Orders', content: { sheets: [
    { name: 'Data', colWidths: {}, cells: { A1: 'Item', B1: 'Unit price', C1: 'Qty', A2: 'Tea', B2: '2', C2: '10', A3: 'Coffee', B3: '3', C3: '5' } },
    { name: 'Report', colWidths: {}, cells: {} },
  ] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
});
await step('name the alternating colours: a table', async () => {
  await cell('B2').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Alternating colours…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Alternating colours' });
  await dlg.getByLabel('Table name (optional)').fill('A1');
  await dlg.getByText('That looks like a cell (A1)').waitFor();
  await dlg.getByLabel('Table name (optional)').fill('Sales');
  await dlg.getByText('Formulas can use it by its columns’ headings').waitFor();
  await page.screenshot({ path: `${SP}/shots/table-name.png` });
  await dlg.getByRole('button', { name: 'Done' }).click();
});
await step('formulas by column name; a row typed under it counts', async () => {
  await typeIn('E1', '=SUM(Sales[Qty])');
  await until(async () => (await cell('E1').innerText()).trim() === '15');
  await typeIn('D2', '=[@Qty]*[@[Unit price]]');
  await until(async () => (await cell('D2').innerText()).trim() === '20');
  await typeIn('A4', 'Cake'); await typeIn('B4', '4'); await typeIn('C4', '1');
  await until(async () => (await cell('E1').innerText()).trim() === '16');
});
await step('from another sheet too', async () => {
  await page.locator('button', { hasText: /^Report$/ }).first().click();
  await typeIn('A1', '=SUMPRODUCT(Sales[Unit price], Sales[Qty])');
  await until(async () => (await cell('A1').innerText()).trim() === String(2 * 10 + 3 * 5 + 4 * 1));
  await page.screenshot({ path: `${SP}/shots/table-report.png` });
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
