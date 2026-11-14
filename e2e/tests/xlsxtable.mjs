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
const ExcelJS = (await import('module')).createRequire(`${ROOT}/server/package.json`)('exceljs');
const upload = (p, name, b64) => p.evaluate(async ([n, d]) => {
  const bytes = Uint8Array.from(atob(d), (c) => c.charCodeAt(0));
  return (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' }, body: bytes })).json();
}, [name, b64]);
await step('setup: an Excel file with a table and formulas using it', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Orders');
  ws.addTable({ name: 'Orders', ref: 'A1', headerRow: true, style: { theme: 'TableStyleMedium2' }, columns: [{ name: 'Item' }, { name: 'Qty' }], rows: [['Tea', 10], ['Cake', 4]] });
  ws.getCell('D1').value = { formula: 'SUM(Orders[Qty])' };
  await upload(page, 'Orders.xlsx', Buffer.from(await wb.xlsx.writeBuffer()).toString('base64'));
  await page.goto(`${B}/drive`);
});
await step('opened as a spreadsheet: the table keeps its name, and its formula grows with it', async () => {
  await page.getByRole('cell', { name: 'Orders.xlsx', exact: true }).dblclick();
  await page.getByRole('dialog', { name: 'Orders.xlsx' }).getByRole('button', { name: 'Open as spreadsheet' }).click();
  await cell('D1').waitFor({ timeout: 20000 });
  await until(async () => (await cell('D1').innerText()).trim() === '14');
  await cell('D1').click();
  const shown = await page.getByLabel('Cell contents').inputValue(); if (shown !== '=SUM(Orders[Qty])') throw new Error(`kept as written: ${shown}`);
  await cell('A4').click(); await page.keyboard.type('Juice'); await page.keyboard.press('Tab'); await page.keyboard.type('6'); await page.keyboard.press('Enter');
  await until(async () => (await cell('D1').innerText()).trim() === '20');
  await cell('B2').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Alternating colours…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Alternating colours' });
  if ((await dlg.getByLabel('Table name (optional)').inputValue()) !== 'Orders') throw new Error('name');
  await page.screenshot({ path: `${SP}/shots/xlsx-table.png` });
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
