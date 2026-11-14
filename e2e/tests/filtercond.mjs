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
await step('condition: Cost greater than 100 hides cheaper rows, for everyone', async () => {
  await cell(page, 'C1').getByRole('button', { name: 'Filter C' }).click();
  const menu = page.getByRole('dialog', { name: 'Filter column C' });
  await menu.getByLabel('Condition', { exact: true }).selectOption('gt');
  await menu.getByLabel('Condition value').fill('100');
  await menu.getByRole('button', { name: 'OK' }).click();
  await until(async () => (await shownRows(page)).startsWith('1,3,4,6'));
  await until(async () => (await shownRows(kim)).startsWith('1,3,4,6'));
  const btn = cell(page, 'C1').getByRole('button', { name: 'Filter C' });
  if (!/on/.test(await btn.getAttribute('class'))) throw new Error('button should show it filters');
  if ((await btn.getAttribute('title')) !== 'Filtered: Greater than 100') throw new Error(await btn.getAttribute('title'));
  await page.screenshot({ path: `${SP}/shots/filtercond.png` });
});
await step('a new row that meets it shows; one that does not, hides', async () => {
  await cell(kim, 'C6').click(); await kim.keyboard.type('900'); await kim.keyboard.press('Enter');
  await cell(kim, 'A6').click(); await kim.keyboard.type('Van'); await kim.keyboard.press('Enter');
  await until(async () => (await shownRows(page)).startsWith('1,3,4,6,7'));
  await cell(kim, 'C3').click(); await kim.keyboard.type('20'); await kim.keyboard.press('Enter');
  await until(async () => (await shownRows(page)).startsWith('1,4,6,7'));
});
await step('the menu opens with the condition; between with text column too', async () => {
  await cell(page, 'C1').getByRole('button', { name: 'Filter C' }).click();
  const menu = page.getByRole('dialog', { name: 'Filter column C' });
  if ((await menu.getByLabel('Condition', { exact: true }).inputValue()) !== 'gt') throw new Error('condition not kept');
  await menu.getByLabel('Condition', { exact: true }).selectOption('between');
  await menu.getByLabel('Condition value').fill('100');
  await menu.getByLabel('Second value').fill('500');
  await menu.getByRole('button', { name: 'OK' }).click();
  await until(async () => (await shownRows(page)).startsWith('1,4,7'));
  await cell(page, 'A1').getByRole('button', { name: 'Filter A' }).click();
  const m2 = page.getByRole('dialog', { name: 'Filter column A' });
  await m2.getByLabel('Condition', { exact: true }).selectOption('contains');
  await m2.getByLabel('Condition value').fill('x');
  await m2.getByRole('button', { name: 'OK' }).click();
  await until(async () => (await shownRows(page)).startsWith('1,7'));
});
await step('None clears a condition', async () => {
  for (const col of ['A', 'C']) {
    await cell(page, `${col}1`).getByRole('button', { name: `Filter ${col}` }).click();
    const menu = page.getByRole('dialog', { name: `Filter column ${col}` });
    await menu.getByLabel('Condition', { exact: true }).selectOption('');
    await menu.getByRole('button', { name: 'OK' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  }
  await until(async () => (await shownRows(page)).startsWith('1,2,3,4,5,6,7'));
  if (/on/.test(await cell(page, 'C1').getByRole('button', { name: 'Filter C' }).getAttribute('class'))) throw new Error('still marked');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
