import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR42u3OMQEAAAgDoNm/tKbwgQJ0Uhk1NBQQEBAQEBAQEBAQEBAQ1gWjYCbJAAAAAElFTkSuQmCC', 'base64');
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
const fmts = async () => (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content.sheets[0].formats || {};
const style = (k, prop) => cell(k).evaluate((el, p) => getComputedStyle(el)[p], prop);
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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget', content: { sheets: [
    { name: 'Summary', colWidths: {}, cells: { A1: 'Total' } },
    { name: 'Q1 data', colWidths: {}, cells: { A1: 'Item', B1: 'Cost', A2: 'Rent', B2: '1000', A3: 'Power', B3: '250' } },
  ] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('A1').waitFor();
});
const content = async () => (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content.sheets;
const tab = (n) => page.locator('.sheet-tab > button', { hasText: n }).first();
await step('a formula adds up cells on another sheet', async () => {
  await cell('B1').dblclick();
  await page.keyboard.type("=SUM('Q1 data'!B2:B3)");
  await page.keyboard.press('Enter');
  await until(async () => (await cell('B1').innerText()).trim() === '1250');
  await cell('B2').dblclick();
  await page.keyboard.type('=Nowhere!A1');
  await page.keyboard.press('Enter');
  await until(async () => (await cell('B2').innerText()).trim() === '#REF!');
});
await step('a change on the other sheet shows straight away', async () => {
  await tab('Q1 data').click();
  await cell('B3').dblclick();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('500');
  await page.keyboard.press('Enter');
  await tab('Summary').click();
  await until(async () => (await cell('B1').innerText()).trim() === '1500');
});
await step('inserting a row on the data sheet moves the reference', async () => {
  await tab('Q1 data').click();
  await cell('A1').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Insert 1 row above' }).click();
  await until(async () => (await content())[0].cells.B1 === "=SUM('Q1 data'!B3:B4)");
  await tab('Summary').click();
  await until(async () => (await cell('B1').innerText()).trim() === '1500');
});
await step('renaming the sheet updates the formula', async () => {
  await tab('Q1 data').click();
  await page.getByRole('button', { name: 'Options for Q1 data' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const d = page.getByRole('dialog', { name: 'Rename sheet' });
  await d.getByLabel('Sheet name').fill('Costs');
  await d.getByLabel('Sheet name').press('Enter');
  await until(async () => (await content())[0].cells.B1 === '=SUM(Costs!B3:B4)');
  await tab('Summary').click();
  await until(async () => (await cell('B1').innerText()).trim() === '1500');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
