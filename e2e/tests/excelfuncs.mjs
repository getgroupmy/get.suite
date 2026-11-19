// Formulas as Excel and Google Sheets files write them: array constants ({1,2,3}, spilling into the cells beside),
// trigonometry, ISNA/ISERR, LOOKUP, REPLACE and more (they used to show #NAME? or #ERROR!); and an Excel file
// using them opens with the right results.
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
  const cells = { A1: 'Name', B1: 'Email', C1: 'Score', A2: 'Ana', B2: 'ana@acme.com', C2: '72', A3: 'Bo', B3: 'bo@north.org', C3: '91', A4: 'Cy', B4: 'cy@acme.com', C4: '58' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Class', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell('C3').getByText('91').waitFor();
});
await step('typed: an array constant spills, and sums', async () => {
  await typeIn('E1', '={10,20,30}');
  await until(async () => (await cell('E1').innerText()) === '10' && (await cell('F1').innerText()) === '20' && (await cell('G1').innerText()) === '30');
  await typeIn('E2', '=SUM({1,2;3,4})');
  await until(async () => (await cell('E2').innerText()) === '10');
});
await step('typed: trigonometry, ISNA, LOOKUP and REPLACE work out (no #NAME?)', async () => {
  await typeIn('E3', '=ROUND(DEGREES(ATAN2(1,1)),2)');
  await typeIn('E4', '=IF(ISNA(MATCH("Zed",A2:A4,0)),"not there","there")');
  await typeIn('E5', '=LOOKUP(80,{0,60,90},{"C","B","A"})');
  await typeIn('E6', '=REPLACE(B2,1,3,"anna")');
  await until(async () => (await cell('E3').innerText()) === '45' && (await cell('E4').innerText()) === 'not there' && (await cell('E5').innerText()) === 'B' && (await cell('E6').innerText()) === 'anna@acme.com');
  const shown = await page.locator('.grid, [role="grid"]').first().innerText();
  if (/#NAME\?|#ERROR!/.test(shown)) throw new Error('an error shows');
});
await step('typed: an inverse matrix spills; distributions, bases and depreciation work out', async () => {
  await typeIn('H5', '=MINVERSE({4,-1;2,0})');
  await typeIn('H8', '=ROUND(F.INV.RT(0.01,6,4),2)');
  await typeIn('H9', '=HEX2BIN("F",8)');
  await typeIn('H10', '=VDB(2400,300,10,0,1)');
  await until(async () => (await cell('H5').innerText()) === '0' && (await cell('I5').innerText()) === '0.5' && (await cell('H6').innerText()) === '-1' && (await cell('I6').innerText()) === '2'
    && (await cell('H8').innerText()) === '15.21' && (await cell('H9').innerText()) === '00001111' && (await cell('H10').innerText()) === '480');
});
await step('typed: AGGREGATE totals a column with an error in it', async () => {
  await typeIn('J1', '5');
  await typeIn('J2', '=1/0');
  await typeIn('J3', '7');
  await typeIn('J4', '=AGGREGATE(9,6,J1:J3)');
  await typeIn('J5', '=SUM(J1:J3)');
  await until(async () => (await cell('J4').innerText()) === '12' && (await cell('J5').innerText()) === '#DIV/0!');
});
await step('suggestions know them, with help', async () => {
  await cell('E7').click();
  await page.keyboard.type('=atan');
  const list = page.getByRole('listbox', { name: 'Function suggestions' });
  await list.waitFor();
  const names = await list.getByRole('option').locator('b').allInnerTexts();
  if (!names.includes('ATAN2')) throw new Error(names.join(','));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});
await step('an Excel file using them opens with the right results', async () => {
  const { excelFromSheet } = await import(`${ROOT}/server/src/office/excel.js`);
  const buf = await excelFromSheet({ sheets: [{ name: 'Sheet1', cells: { A1: 'x', A2: '=ROUND(SIN(PI()/2),0)', A3: '=ISERR(1/0)', A4: '=SUM({2,3,4})', A5: '=LOOKUP(2,{1,2,3},{"a","b","c"})' } }] });
  const up = await page.request.post(`${B}/api/files/upload?name=${encodeURIComponent('From Excel.xlsx')}`, { headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' }, data: buf });
  const f = await up.json();
  const made = await api(page, 'POST', `/files/${f.id}/open-as`);
  await page.goto(`${B}/sheets/${made.body.id}`);
  await until(async () => (await cell('A2').innerText()) === '1' && (await cell('A3').innerText()) === 'TRUE' && (await cell('A4').innerText()) === '9' && (await cell('A5').innerText()) === 'b', 15000);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
