import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
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
let sheetId, kim, vic;
const cell = (p, k) => p.locator(`[data-k="${k}"]`);
const shownRows = (p) => p.locator('.grid-wrap tbody tr > th').allInnerTexts().then((l) => l.slice(0, 7).join(','));
const views = async (p) => {
  await p.getByRole('button', { name: 'More', exact: true }).click();
  await p.getByRole('menuitem', { name: 'Filter views' }).click();
  return p.getByRole('dialog', { name: 'Filter views' });
};
const hideIn = async (p, col, value) => {
  await cell(p, `${col}1`).getByRole('button', { name: `Filter ${col}` }).click();
  const menu = p.getByRole('dialog', { name: `Filter column ${col}` });
  await menu.getByLabel(value).uncheck();
  await menu.getByRole('button', { name: 'OK' }).click();
};
const bar = (p) => p.getByRole('region', { name: 'Filter view' });
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
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const vicId = (await api(page, 'POST', '/users', { local: 'vic', domain: 'acme.com', name: 'Vic Viewer', password: 'password123' })).body.id;
  const cells = { A1: 'Job', B1: 'Status', C1: 'Cost', A2: 'Logo', B2: 'Done', C2: '40', A3: 'Site', B3: 'Open', C3: '250', A4: 'Ads', B4: 'Done', C4: '120', A5: 'Flyers', B5: 'Open', C5: '30' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Jobs', content: { sheets: [{ name: 'Sheet1', cells }, { name: 'Other', cells: { A1: 'x' } }] } })).body.id;
  await api(page, 'PUT', `/files/${sheetId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }, { user_id: vicId, role: 'viewer' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  vic = await mk('vic'); await signIn(vic, 'vic@acme.com');
  for (const p of [page, kim, vic]) { await p.goto(`${B}/sheets/${sheetId}`); await cell(p, 'A5').getByText('Flyers').waitFor(); }
});
await step('New filter view: a dark bar, and rows hidden only for Olivia', async () => {
  await cell(page, 'B3').click();
  const d = await views(page);
  await d.getByText('This sheet has no filter views yet.').waitFor();
  await d.getByRole('button', { name: 'New filter view' }).click();
  await bar(page).waitFor();
  if (await bar(page).getByLabel('Filter view name').inputValue() !== 'Filter 1') throw new Error('name');
  await hideIn(page, 'B', 'Done');
  await until(async () => (await shownRows(page)).startsWith('1,3,5,6'));
  await new Promise((r) => setTimeout(r, 800));
  if (!(await shownRows(kim)).startsWith('1,2,3,4,5,6')) throw new Error(`Kim's rows changed: ${await shownRows(kim)}`);
  if (await kim.locator('.filter-btn').count()) throw new Error('Kim sees filter buttons');
  await page.screenshot({ path: `${SP}/shots/fview.png` });
});
await step('rename it; Kim opens it from Filter views and closes it again', async () => {
  const name = bar(page).getByLabel('Filter view name');
  await name.fill('Open jobs'); await name.press('Enter');
  const d = await views(kim);
  await d.getByRole('button', { name: 'Open jobs' }).click();
  await bar(kim).getByLabel('Filter view name').waitFor();
  await until(async () => (await shownRows(kim)).startsWith('1,3,5,6'));
  await bar(kim).getByRole('button', { name: 'Close filter view' }).click();
  await until(async () => (await shownRows(kim)).startsWith('1,2,3,4,5,6'));
  if (await bar(kim).count()) throw new Error('bar still there');
});
await step('Copy link opens the spreadsheet with the view on (for the viewer too)', async () => {
  await bar(page).getByRole('button', { name: 'Copy link' }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  if (!/\/sheets\/.+\?fv=\w+$/.test(link)) throw new Error(link);
  await vic.goto(link);
  await bar(vic).waitFor();
  await bar(vic).getByText('Open jobs').waitFor();
  await until(async () => (await shownRows(vic)).startsWith('1,3,5,6'));
  if (await bar(vic).getByRole('button', { name: 'Delete' }).count()) throw new Error('viewer can delete');
});
await step('the viewer filters further: a temporary view only for them, nothing saved', async () => {
  await hideIn(vic, 'A', 'Flyers');
  await bar(vic).getByText('Temporary filter view').waitFor({ state: 'detached' }).catch(() => {});
  await until(async () => (await shownRows(vic)).startsWith('1,3,6'));
  await bar(vic).getByText(/not saved/).waitFor();
  await new Promise((r) => setTimeout(r, 600));
  if (!(await shownRows(page)).startsWith('1,3,5,6')) throw new Error(`Olivia's view changed: ${await shownRows(page)}`);
});
await step('the viewer makes a new temporary filter view on the sheet', async () => {
  await bar(vic).getByRole('button', { name: 'Close filter view' }).click();
  await until(async () => (await shownRows(vic)).startsWith('1,2,3,4,5,6'));
  await cell(vic, 'A2').click();
  const d = await views(vic);
  await d.getByRole('button', { name: 'Open jobs' }).waitFor();
  await d.getByRole('button', { name: 'New temporary filter view' }).click();
  await bar(vic).getByText('Temporary filter view').waitFor();
  await hideIn(vic, 'B', 'Open');
  await until(async () => (await shownRows(vic)).startsWith('1,2,4,6'));
  await vic.getByRole('button', { name: 'Other', exact: true }).click();
  await until(async () => !(await bar(vic).count()));
});
await step('the sheet’s own Filter can’t be changed while a view is open', async () => {
  await page.getByRole('button', { name: 'Create a filter' }).click();
  await page.getByText('Close the filter view to change the sheet’s own filter').waitFor();
});
await step('inserting a column moves the view with it', async () => {
  await api(page, 'GET', `/files/${sheetId}`);
  await cell(page, 'A1').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Insert 1 column left/ }).click();
  await cell(page, 'C1').getByRole('button', { name: 'Filter C' }).waitFor();
  await until(async () => (await shownRows(page)).startsWith('1,3,5,6'));
  if (!/on/.test(await cell(page, 'C1').getByRole('button', { name: 'Filter C' }).getAttribute('class'))) throw new Error('the filtered column should be C now');
});
await step('Delete: the view goes for everyone', async () => {
  await bar(page).getByRole('button', { name: 'Delete' }).click();
  await page.getByText('Filter view deleted').waitFor();
  await until(async () => (await shownRows(page)).startsWith('1,2,3,4,5,6'));
  const d = await views(kim);
  await d.getByText('This sheet has no filter views yet.').waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
