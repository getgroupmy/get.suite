import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
const ben = await mk('ben');
const cat = await mk('cat');
const cell = (p, k) => p.locator(`.grid td[data-k="${k}"]`);
let sheet, ids = {};
const sheetNow = async () => (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content.sheets[0];
const type = async (p, k, text) => { await cell(p, k).click(); await p.keyboard.type(text); await p.keyboard.press('Enter'); };
await step('people, and a shared spreadsheet', async () => {
  for (const [local, name] of [['ben', 'Ben Baker'], ['cat', 'Cat Cole']]) ids[local] = (await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' })).body.id;
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Prices', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: 'Item', B1: 'Price', A2: 'Tea', B2: '4' } }, { name: 'Rates', cells: { A1: '0.2' } }] } })).body;
  const r = await api(page, 'PUT', `/files/${sheet.id}/shares`, { shares: [{ user_id: ids.ben, role: 'editor' }, { user_id: ids.cat, role: 'editor' }] });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell(page, 'A1').waitFor();
});
await step('protect B1:B10 for Cat only, and the Rates sheet with a warning', async () => {
  await cell(page, 'B1').click();
  await cell(page, 'B10').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Protected sheets and ranges' }).click();
  const d = page.getByRole('dialog', { name: 'Protected sheets and ranges' });
  await d.getByText('Nothing on this sheet is protected.').waitFor();
  await d.getByRole('button', { name: 'Add a protection' }).click();
  if (await d.getByLabel('Cells').inputValue() !== 'B1:B10') throw new Error('prefilled ' + await d.getByLabel('Cells').inputValue());
  await d.getByLabel('Description (optional)').fill('Prices: ask Finance');
  await d.getByRole('group', { name: 'People who can edit it' }).getByLabel('Cat Cole').check();
  await d.getByRole('button', { name: 'Protect' }).click();
  await d.getByText('Only you, Cat Cole can edit').waitFor();
  await d.getByRole('button', { name: 'Done' }).click();
  await until(async () => (await sheetNow()).protected?.[0]?.range === 'B1:B10');
  const p = (await sheetNow()).protected[0];
  if (JSON.stringify(p.editors) !== JSON.stringify([ids.cat]) || p.desc !== 'Prices: ask Finance') throw new Error(JSON.stringify(p));
  // The owner can still type there.
  await type(page, 'B3', '5');
  await until(async () => (await sheetNow()).cells.B3 === '5');
  // Whole Rates sheet, warning only.
  await page.getByRole('tab', { name: 'Rates' }).click().catch(async () => page.getByText('Rates', { exact: true }).click());
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Protected sheets and ranges' }).click();
  await d.getByRole('button', { name: 'Add a protection' }).click();
  await d.getByLabel('Whole sheet').check();
  await d.getByLabel('Anyone who can edit, after a warning').check();
  await d.getByRole('button', { name: 'Protect' }).click();
  await d.getByText('Whole sheet “Rates”').waitFor();
  await d.getByRole('button', { name: 'Done' }).click();
});
await step('Ben can\'t change protected cells, but can change the rest', async () => {
  await signIn(ben, 'ben@acme.com');
  await ben.goto(`${B}/sheets/${sheet.id}`);
  await cell(ben, 'B2').waitFor();
  if (!(await cell(ben, 'B2').getAttribute('class')).includes('guarded')) throw new Error('not hatched');
  if ((await cell(ben, 'A2').getAttribute('class')).includes('guarded')) throw new Error('A2 hatched');
  await cell(ben, 'B2').dblclick();
  await ben.getByText(/This cell is protected \(Prices: ask Finance\)/).waitFor();
  await type(ben, 'A3', 'Coffee');
  await until(async () => (await sheetNow()).cells.A3 === 'Coffee');
  // Clearing a range that reaches into the protection is refused as a whole.
  await cell(ben, 'A2').click();
  await cell(ben, 'B2').click({ modifiers: ['Shift'] });
  await ben.keyboard.press('Delete');
  await ben.getByText(/Sheet1!B1:B10 is protected/).first().waitFor();
  if ((await sheetNow()).cells.A2 !== 'Tea') throw new Error('A2 cleared');
  // Inserting a row above it would move it: refused too.
  await cell(ben, 'A1').click({ button: 'right' });
  await ben.getByRole('menuitem', { name: 'Insert 1 row above' }).click();
  await ben.getByText(/Sheet1!B1:B10 is protected/).first().waitFor();
  if ((await sheetNow()).cells.B2 !== '4') throw new Error('moved');
  // Filling into it (Ctrl+R from A3 into B3) is refused too.
  await cell(ben, 'B3').click();
  await ben.keyboard.press('Control+r');
  await ben.getByText(/Sheet1!B1:B10 is protected/).first().waitFor();
  if ((await sheetNow()).cells.B3 !== '5') throw new Error('filled');
  // Ben sees the protection but can't change or remove it.
  await ben.getByRole('button', { name: 'More' }).click();
  await ben.getByRole('menuitem', { name: 'Protected sheets and ranges' }).click();
  const d = ben.getByRole('dialog', { name: 'Protected sheets and ranges' });
  await d.getByText('Only Olivia Owner, Cat Cole can edit').waitFor();
  if (await d.getByRole('button', { name: /Remove B1:B10/ }).count()) throw new Error('remove offered');
  await d.getByRole('button', { name: 'Done' }).click();
}, ben);
await step('Ben gets a warning on the Rates sheet and can go ahead', async () => {
  await ben.getByText('Rates', { exact: true }).click();
  await cell(ben, 'A1').waitFor();
  await type(ben, 'A1', '0.25');
  const d = ben.getByRole('dialog', { name: 'Change protected cells?' });
  await d.getByText(/The sheet “Rates” is marked to be changed with care/).waitFor();
  await d.getByRole('button', { name: 'Change anyway' }).click();
  await until(async () => (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content.sheets[1].cells.A1 === '0.25');
  // Only asked once.
  await type(ben, 'A2', 'x');
  await until(async () => (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content.sheets[1].cells.A2 === 'x');
  if (await d.count()) throw new Error('asked again');
}, ben);
await step('Cat, who is listed, can change the protected cells', async () => {
  await signIn(cat, 'cat@acme.com');
  await cat.goto(`${B}/sheets/${sheet.id}`);
  await cell(cat, 'B2').waitFor();
  if ((await cell(cat, 'B2').getAttribute('class')).includes('guarded')) throw new Error('hatched for Cat');
  await type(cat, 'B2', '4.5');
  await until(async () => (await sheetNow()).cells.B2 === '4.5');
}, cat);
await step('the owner inserts a row: the protection moves with its cells, and can be removed', async () => {
  await page.getByText('Sheet1', { exact: true }).click();
  await cell(page, 'A1').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Insert 1 row above' }).click();
  await until(async () => (await sheetNow()).protected?.[0]?.range === 'B2:B11');
  await ben.getByText('Sheet1', { exact: true }).click();
  await until(async () => (await cell(ben, 'B3').getAttribute('class')).includes('guarded'));
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Protected sheets and ranges' }).click();
  const d = page.getByRole('dialog', { name: 'Protected sheets and ranges' });
  await d.getByRole('button', { name: 'Remove B2:B11 protection' }).click();
  await d.getByText('Nothing on this sheet is protected.').waitFor();
  await d.getByRole('button', { name: 'Done' }).click();
  await until(async () => !(await sheetNow()).protected);
  await until(async () => !(await cell(ben, 'B3').getAttribute('class')).includes('guarded'));
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
