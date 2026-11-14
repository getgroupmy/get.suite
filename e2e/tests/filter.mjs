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
let sheetId, kim;
const cell = (p, k) => p.locator(`[data-k="${k}"]`);
const shownRows = (p) => p.locator('.grid-wrap tbody tr > th').allInnerTexts().then((l) => l.slice(0, 7).join(','));
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
  const cells = { A1: 'Job', B1: 'Status', C1: 'Cost', A2: 'Logo', B2: 'Done', C2: '40', A3: 'Site', B3: 'Open', C3: '250', A4: 'Ads', B4: 'Done', C4: '120', A5: 'Flyers', C5: '30' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Jobs', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await api(page, 'PUT', `/files/${sheetId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/sheets/${sheetId}`); await cell(p, 'A5').getByText('Flyers').waitFor(); }
});
await step('Filter on the table around the cursor: headings get buttons', async () => {
  await cell(page, 'B3').click();
  await page.getByRole('button', { name: 'Create a filter' }).click();
  await cell(page, 'B1').getByRole('button', { name: 'Filter B' }).waitFor();
  await cell(kim, 'C1').getByRole('button', { name: 'Filter C' }).waitFor();
});
await step('hide “Done”: those rows go, for everyone', async () => {
  await cell(page, 'B1').getByRole('button', { name: 'Filter B' }).click();
  const menu = page.getByRole('dialog', { name: 'Filter column B' });
  await menu.getByLabel('Done').uncheck();
  await menu.getByRole('button', { name: 'OK' }).click();
  await until(async () => (await shownRows(page)).startsWith('1,3,5,6'));
  await until(async () => (await shownRows(kim)).startsWith('1,3,5,6'));
  if (!/on/.test(await cell(page, 'B1').getByRole('button', { name: 'Filter B' }).getAttribute('class'))) throw new Error('button should show it filters');
  await page.screenshot({ path: `${SP}/shots/filter.png` });
});
await step('the arrow keys skip hidden rows', async () => {
  await cell(page, 'A1').click();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  const name = await page.locator('.cell-name').inputValue();
  if (name !== 'A5') throw new Error(name);
});
await step('blanks, search and sort from the menu', async () => {
  await cell(page, 'B1').getByRole('button', { name: 'Filter B' }).click();
  const menu = page.getByRole('dialog', { name: 'Filter column B' });
  await menu.getByLabel('(Blanks)').uncheck();
  await menu.getByRole('button', { name: 'OK' }).click();
  await until(async () => (await shownRows(page)).startsWith('1,3,6'));
  await cell(page, 'C1').getByRole('button', { name: 'Filter C' }).click();
  await page.getByRole('dialog', { name: 'Filter column C' }).getByRole('button', { name: 'Sort Z → A' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await until(async () => (await cell(page, 'A2').innerText()).trim() === 'Site'); // 250 first
});
await step('typing a hidden value hides the row as it changes', async () => {
  await until(async () => (await cell(kim, 'B2').innerText()).trim() === 'Open');
  await cell(kim, 'B2').click();
  await kim.keyboard.type('Done'); await kim.keyboard.press('Enter');
  await until(async () => !(await shownRows(page)).startsWith('1,2'));
});
await step('remove the filter: every row is back', async () => {
  await page.getByRole('button', { name: 'Remove filter' }).click();
  await until(async () => (await shownRows(page)).startsWith('1,2,3,4,5,6'));
  if (await page.locator('.filter-btn').count()) throw new Error('buttons left');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
