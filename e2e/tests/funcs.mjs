import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
import JSZip from '../../server/node_modules/jszip/lib/index.js';
import fs from 'node:fs';
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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Orders', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: {
    A1: 'Item', B1: 'Amount', A2: 'pear', B2: '120', A3: 'fig', B3: '80', A4: 'banana', B4: '0',
    H1: 'Item', I1: 'Amount', H2: 'pear', I2: '>50',
  } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
});
await step('a function of one value given a range fills a cell for each', async () => {
  await typeIn('C2', '=LEN(A2:A4)');
  await expectCells({ C2: '4', C3: '3', C4: '6' });
  await typeIn('D2', '=IF(B2:B4>100, "big", "small")');
  await expectCells({ D2: 'big', D3: 'small', D4: 'small' });
  // One cell that can't be worked out shows its error; the others keep their values.
  await typeIn('E2', '=100/B2:B4');
  await expectCells({ E3: '1.25', E4: '#DIV/0!' });
  await typeIn('F2', '=ARRAYFORMULA(IFERROR(100/B2:B4, "none"))');
  await expectCells({ F3: '1.25', F4: 'none' });
  await page.screenshot({ path: `${SP}/shots/funcs-lift.png` });
  // Something in the way: the formula's cell says so.
  await typeIn('G3', 'x');
  await typeIn('G2', '=UPPER(A2:A4)');
  await expectCells({ G2: '#SPILL!' });
});
await step('the new functions are suggested with help on their arguments', async () => {
  await cell('A7').click();
  await page.keyboard.type('=t.te');
  const list = page.getByRole('listbox', { name: 'Function suggestions' });
  await list.waitFor();
  const names = await list.getByRole('option').locator('b').allInnerTexts();
  if (!names.includes('T.TEST')) throw new Error(names.join(','));
  await page.keyboard.press('Tab');
  const help = page.getByRole('status', { name: 'Function help' });
  if ((await help.locator('b').innerText()) !== 'range1') throw new Error('first argument bold');
  if (!(await help.innerText()).includes('p-value of a t-test')) throw new Error(await help.innerText());
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});
await step('statistics, loans, dates in words and database functions give Excel\'s answers', async () => {
  await typeIn('A8', '=ROUND(NORM.S.INV(0.975), 4)');
  await typeIn('A9', '=ROUND(IPMT(0.1/12, 1, 36, 8000), 2)');
  await typeIn('A10', '=TO_DATE(DATEVALUE("9 Nov 2026") + 7)');
  await typeIn('A11', '=DSUM(A1:B4, "Amount", H1:I2)');
  await typeIn('A12', '=FORMULATEXT(A8)');
  await typeIn('A13', '=ROUND(T.INV.2T(0.05, 10), 3)');
  await expectCells({ A8: '1.96', A9: '-66.67', A10: '2026-11-16', A11: '120', A12: '=ROUND(NORM.S.INV(0.975), 4)', A13: '2.228' });
  await typeIn('A14', '=NORM.INV(2, 0, 1)');
  await expectCells({ A14: '#NUM!' });
  await page.screenshot({ path: `${SP}/shots/funcs-values.png` });
});
await step('newer functions are written the way Excel expects in the .xlsx download', async () => {
  await page.waitForTimeout(1500); // saved
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as Excel (.xlsx)' }).click()]);
  const file = `${SP}/funcs-dl.xlsx`;
  await dl.saveAs(file);
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  if (!xml.includes('_xlfn.NORM.S.INV(0.975)')) throw new Error(xml.match(/<f>[^<]*NORM[^<]*<\/f>/)?.[0] || 'no NORM formula');
  if (!xml.includes('_xlfn.T.INV.2T(0.05,10)') && !xml.includes('_xlfn.T.INV.2T(0.05, 10)')) throw new Error(xml.match(/<f>[^<]*T\.INV[^<]*<\/f>/)?.[0] || 'no T.INV');
  if (!/<f>[^<]*IPMT\(/.test(xml) || /_xlfn\.IPMT/.test(xml)) throw new Error('IPMT is an old function: no prefix');
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
