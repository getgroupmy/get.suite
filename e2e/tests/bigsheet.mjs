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
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
let sheetId;
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
});
const cell = (k) => page.locator(`[data-k="${k}"]`);
const drawn = () => page.locator('.grid tbody td[data-k]').count();
await step('a sheet of 5,000 rows opens with only the rows near the screen drawn', async () => {
  const cells = { A1: 'Row', B1: 'Value' };
  for (let r = 2; r <= 5000; r++) { cells[`A${r}`] = `Item ${r}`; cells[`B${r}`] = String(r * 3); }
  cells.C3000 = 'needle';
  cells.D4980 = 'merged block';
  const f = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Big list', content: { sheets: [{ name: 'Sheet1', cells, frozen: { rows: 1 }, merges: ['D4980:E4990'] }] } })).body;
  sheetId = f.id;
  const t = Date.now();
  await page.goto(`${B}/sheets/${f.id}`);
  await cell('A2').waitFor();
  console.log(`  opened in ${Date.now() - t} ms, ${await drawn()} cells drawn`);
  if (await drawn() > 4000) throw new Error(`${await drawn()} cells drawn`);
  if (await cell('A2000').count()) throw new Error('row 2000 drawn at the top');
  // The page is as tall as all 5,000 rows, so the scroll bar is right.
  const h = await page.evaluate(() => document.querySelector('.grid-wrap').scrollHeight);
  if (h < 5000 * 24) throw new Error(`grid only ${h}px tall`);
});
await step('scrolling down draws the rows that come into view, with the frozen heading row kept', async () => {
  await page.evaluate(() => { const g = document.querySelector('.grid-wrap'); g.scrollTop = 2500 * 25; });
  await cell('A2500').waitFor();
  if (!(await cell('A2500').isVisible())) throw new Error('row 2500 not visible');
  if ((await cell('A2500').innerText()).trim() !== 'Item 2500') throw new Error(await cell('A2500').innerText());
  if (!(await cell('A1').isVisible())) throw new Error('frozen heading row not shown');
  const box = await cell('A1').boundingBox(), grid = await page.locator('.grid-wrap').boundingBox();
  if (box.y > grid.y + 40) throw new Error(`heading row at ${box.y}, grid at ${grid.y}`);
  await page.evaluate(() => { const g = document.querySelector('.grid-wrap'); g.scrollTop = g.scrollHeight; });
  await cell('A5000').waitFor();
  if (!(await cell('A5000').isVisible())) throw new Error('last row not visible at the bottom');
});
await step('the merged cell near the end is drawn whole', async () => {
  const td = cell('D4980');
  if ((await td.getAttribute('rowspan')) !== '11') throw new Error(`rowspan ${await td.getAttribute('rowspan')}`);
  const a = await td.boundingBox(), b = await cell('A4990').boundingBox();
  if (Math.abs(a.y + a.height - (b.y + b.height)) > 2) throw new Error(`merge ends at ${a.y + a.height}, row 4990 at ${b.y + b.height}`);
});
await step('the Name box goes to a cell far away, and Ctrl+Home back to the top', async () => {
  await page.getByLabel('Name box').click();
  await page.getByLabel('Name box').fill('B3500');
  await page.keyboard.press('Enter');
  await cell('B3500').waitFor();
  await until(async () => (await cell('B3500').getAttribute('class')).includes('sel') && await cell('B3500').isVisible());
  await page.locator('.grid-wrap').focus();
  await page.keyboard.press('Control+Home');
  await until(async () => (await cell('A1').getAttribute('class')).includes('sel'));
  await until(() => page.evaluate(() => document.querySelector('.grid-wrap').scrollTop < 50));
  await cell('A2').waitFor();
});
await step('Ctrl+Down jumps to the end of the data, Ctrl+End to the last cell used, Page Down a screen at a time', async () => {
  await page.getByLabel('Name box').fill('B2');
  await page.keyboard.press('Enter');
  await page.locator('.grid-wrap').focus();
  await page.keyboard.press('Control+ArrowDown');
  await until(async () => (await cell('B5000').count()) && (await cell('B5000').getAttribute('class')).includes('sel') && await cell('B5000').isVisible());
  await page.keyboard.press('Control+Home');
  await until(async () => (await cell('A1').getAttribute('class')).includes('sel'));
  await page.keyboard.press('Control+End');
  await until(async () => (await cell('D5000').count()) && (await cell('D5000').getAttribute('class')).includes('sel'));
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('PageDown');
  const r = await until(() => page.evaluate(() => { const td = document.querySelector('.grid td.sel'); return td && +td.dataset.k.slice(1); }));
  if (r < 15 || r > 60) throw new Error(`Page Down went to row ${r}`);
  await page.keyboard.press('Control+Shift+ArrowDown');
  await until(async () => /^A\d+:A5000$/.test(await page.getByLabel('Name box').inputValue()));
});
await step('arrow keys walk past the drawn rows', async () => {
  await page.getByLabel('Name box').fill('A2');
  await page.keyboard.press('Enter');
  await page.locator('.grid-wrap').focus();
  for (let i = 0; i < 80; i++) await page.keyboard.press('ArrowDown');
  await until(async () => (await cell('A82').count()) && (await cell('A82').getAttribute('class')).includes('sel'));
  if (!(await cell('A82').isVisible())) throw new Error('selected cell scrolled out of view');
});
await step('find goes to a match thousands of rows down', async () => {
  await page.keyboard.press('Control+f');
  await page.getByLabel('Find', { exact: true }).fill('needle');
  await page.keyboard.press('Enter');
  await cell('C3000').waitFor();
  await until(async () => /find-current|sel/.test(await cell('C3000').getAttribute('class')) && await cell('C3000').isVisible());
  await page.keyboard.press('Escape');
});
await step('a cell typed in far down is saved', async () => {
  await page.getByLabel('Name box').fill('B4321');
  await page.keyboard.press('Enter');
  await cell('B4321').waitFor();
  await cell('B4321').dblclick();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('=B4320+1');
  await page.keyboard.press('Enter');
  await until(async () => (await cell('B4321').innerText()).trim() === String(4320 * 3 + 1));
  await until(async () => (await api(page, 'GET', `/files/${sheetId}/content`)).body?.content?.sheets?.[0]?.cells?.B4321 === '=B4320+1', 12000);
});
await step('a wide sheet (200 columns) draws only the columns in view; scrolling, the Name box, Ctrl+Right and a frozen column work', async () => {
  const col = (n) => { let x = ''; for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) x = String.fromCharCode(65 + ((n - 1) % 26)) + x; return x; };
  const cells = {};
  for (let r = 1; r <= 60; r++) for (let c = 0; c < 200; c++) cells[`${col(c)}${r}`] = r === 1 ? `H${c}` : String(r * 1000 + c);
  const f = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Wide', content: { sheets: [{ name: 'Sheet1', cells, frozen: { cols: 1 }, merges: ['FA5:FC6'] }] } })).body;
  await page.goto(`${B}/sheets/${f.id}`);
  await cell('B2').waitFor();
  const heads = await page.locator('.grid thead th:not(.corner):not(.grid-gap-c)').count();
  if (heads > 60) throw new Error(`${heads} columns drawn`);
  const w = await page.evaluate(() => document.querySelector('.grid-wrap').scrollWidth);
  if (w < 200 * 99) throw new Error(`grid only ${w}px wide`);
  await page.evaluate(() => { document.querySelector('.grid-wrap').scrollLeft = 120 * 100; });
  await cell('DQ10').waitFor();
  if (!(await cell('DQ10').isVisible()) || (await cell('DQ10').innerText()).trim() !== '10120') throw new Error('column DQ not shown');
  if (!(await cell('A10').isVisible())) throw new Error('frozen column A not shown');
  const a = await cell('A10').boundingBox(), g = await page.locator('.grid-wrap').boundingBox();
  if (a.x > g.x + 60) throw new Error(`frozen column at ${a.x}`);
  // Each row lines up: DQ10 sits under its heading.
  const h = await page.locator('.grid thead th', { hasText: /^DQ$/ }).boundingBox(), d = await cell('DQ10').boundingBox();
  if (Math.abs(h.x - d.x) > 2) throw new Error(`heading at ${h.x}, cell at ${d.x}`);
  await page.getByLabel('Name box').fill('GR40');
  await page.keyboard.press('Enter');
  await until(async () => (await cell('GR40').count()) && (await cell('GR40').getAttribute('class')).includes('sel') && await cell('GR40').isVisible());
  await page.getByLabel('Name box').fill('B3');
  await page.keyboard.press('Enter');
  await page.locator('.grid-wrap').focus();
  await page.keyboard.press('Control+ArrowRight');
  await until(async () => (await cell('GR3').count()) && (await cell('GR3').getAttribute('class')).includes('sel') && await cell('GR3').isVisible());
  // The merged cell near the end is whole.
  await page.evaluate(() => { document.querySelector('.grid-wrap').scrollLeft = 152 * 100; });
  await cell('FA5').waitFor();
  if ((await cell('FA5').getAttribute('colspan')) !== '3') throw new Error(`colspan ${await cell('FA5').getAttribute('colspan')}`);
  await page.keyboard.press('Control+Home');
  await until(() => page.evaluate(() => document.querySelector('.grid-wrap').scrollLeft < 10));
  await cell('B2').waitFor();
});
await step('a small sheet still draws every row', async () => {
  const f = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Small', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'x', A150: 'y' } }] } })).body;
  await page.goto(`${B}/sheets/${f.id}`);
  await cell('A170').waitFor({ state: 'attached' });
  if (await page.locator('.grid-gap').count()) throw new Error('gap rows in a small sheet');
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
