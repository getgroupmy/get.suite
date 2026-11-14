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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Funcs', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: 'Quarterly report', B1: 'stray', A2: 'Item', B2: 'Qty', C2: 'Price', A3: 'Bolts', B3: '4', C3: '2', D1: 'right' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
});
const mergesNow = async () => (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content.sheets[0].merges || [];
await step('select A1:C1 and merge: one wide cell, other values cleared', async () => {
  await cell('A1').click();
  await cell('C1').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Merge cells' }).click();
  await page.getByText(/^Merged: only the top-left value is kept \(1 other value cleared/).waitFor();
  if ((await cell('A1').getAttribute('colspan')) !== '3') throw new Error('colspan ' + await cell('A1').getAttribute('colspan'));
  if (await cell('B1').count()) throw new Error('B1 still drawn');
  const w = (await cell('A1').boundingBox()).width, w2 = (await cell('A2').boundingBox()).width;
  if (w < w2 * 2.5) throw new Error(`not wide: ${w} vs ${w2}`);
  await until(async () => (await mergesNow()).join() === 'A1:C1');
  await page.screenshot({ path: process.argv[2] + '/shots/merge.png' });
});
await step('arrows move over the merge as one cell', async () => {
  await cell('A2').click();
  await page.keyboard.press('ArrowUp');
  if ((await page.locator('.formula-bar .cell-name').inputValue()) !== 'A1') throw new Error('up into it');
  await page.keyboard.press('ArrowRight');
  if ((await page.locator('.formula-bar .cell-name').inputValue()) !== 'D1') throw new Error('right out of it: ' + await page.locator('.formula-bar .cell-name').inputValue());
});
await step('a row inserted above moves it; sorting across it is refused; Unmerge', async () => {
  await cell('A1').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Insert 1 row above|Insert row above/ }).click();
  await until(async () => (await mergesNow()).join() === 'A2:C2');
  await cell('A4').click();
  await cell('C1').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Sort range' }).click();
  const dlg = page.getByRole('dialog');
  if (await dlg.count()) { await dlg.getByRole('button', { name: /^Sort/ }).last().click(); }
  await page.getByText('Unmerge the cells in these rows before sorting them').waitFor();
  await page.keyboard.press('Escape');
  await cell('A2').click();
  await page.getByRole('button', { name: 'Unmerge cells' }).click();
  await until(async () => (await mergesNow()).length === 0);
  await cell('B2').waitFor();
  if ((await cell('A2').innerText()) !== 'Quarterly report') throw new Error('value kept');
});
await step('Undo brings the merge back', async () => {
  await page.keyboard.press('Control+z');
  await until(async () => (await cell('A2').getAttribute('colspan')) === '3');
});
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
