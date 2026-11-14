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
  const cells = { A1: 'Region', B1: 'Rep', C1: 'Sales', A2: 'North', B2: 'Ana', C2: '10', A3: 'South', B3: 'Ben', C3: '4', A4: 'North', B4: 'Cleo', C4: '7', A5: 'East', B5: 'Dev', C5: '5' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Numbers', content: { sheets: [{ name: 'Sheet1', cells, charts: { k: { type: 'column', range: 'B1:C5', title: 'Sales by rep', x: 520, y: 200, w: 420, h: 260 } } }] } })).body.id;
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell('C5').getByText('5').waitFor();
});
const chart = () => page.getByRole('region', { name: 'Chart: Sales by rep' });
const shownRows = async () => { const out = []; for (const r of [2, 3, 4, 5]) if (await cell(`A${r}`).isVisible()) out.push(r); return out; };
await step('a slicer filters the table by its column, and the chart follows', async () => {
  await cell('A3').click();
  await page.getByRole('button', { name: 'Add a slicer' }).click();
  const chip = page.getByRole('button', { name: /^Slicer: Region, showing All/ });
  await chip.waitFor();
  await chip.click();
  const menu = page.getByRole('dialog', { name: 'Slicer: Region' });
  await menu.getByRole('checkbox', { name: /South/ }).uncheck();
  await menu.getByRole('checkbox', { name: /East/ }).uncheck();
  await menu.getByRole('button', { name: 'OK' }).click();
  await page.getByRole('button', { name: /^Slicer: Region, showing North/ }).waitFor();
  await until(async () => (await shownRows()).join() === '2,4');
  await chart().getByRole('button', { name: 'Show data' }).click();
  const reps = await chart().locator('tbody th').allInnerTexts();
  if (reps.join() !== 'Ana,Cleo') throw new Error(reps.join());
  await chart().getByRole('button', { name: 'Show chart' }).click();
  await page.screenshot({ path: `${SP}/shots/slicer.png` });
});
await step('it is kept, and shows for others too', async () => {
  await page.waitForTimeout(1200);
  await page.reload();
  await page.getByRole('button', { name: /^Slicer: Region, showing North/ }).waitFor();
  await until(async () => (await shownRows()).join() === '2,4');
});
await step('it can filter by another column, show all, and be deleted', async () => {
  await page.getByRole('button', { name: 'Options for slicer Region' }).click();
  await page.getByRole('menuitem', { name: 'Show all' }).click();
  await until(async () => (await shownRows()).join() === '2,3,4,5');
  await page.getByRole('button', { name: 'Options for slicer Region' }).click();
  await page.getByRole('menuitem', { name: 'Filter by Rep' }).click();
  await page.getByRole('button', { name: /^Slicer: Rep, showing All/ }).waitFor();
  await page.getByRole('button', { name: 'Options for slicer Rep' }).click();
  await page.getByRole('menuitem', { name: 'Delete slicer' }).click();
  await page.getByRole('button', { name: /^Slicer:/ }).waitFor({ state: 'detached' });
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
