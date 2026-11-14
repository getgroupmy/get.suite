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
let docId, sheetId, deckId;
const more = async () => page.getByRole('button', { name: 'More', exact: true }).click();
const hist = () => page.getByRole('dialog', { name: 'Version history' });
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
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Proposal', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Price: 10,000' }] }] } })).body.id;
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Quote', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Total', B1: '=2*500' } }] } })).body.id;
  deckId = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Pitch' })).body.id;
});
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const nameCurrent = async (label) => {
  await more(); await page.getByRole('menuitem', { name: 'Version history' }).click();
  await hist().getByRole('button', { name: 'Name current version' }).click();
  await hist().getByLabel('Name for the file as it is now').fill(label);
  await hist().getByRole('button', { name: 'Save' }).click();
  await hist().getByRole('button', { name: new RegExp(label) }).waitFor();
  await page.keyboard.press('Escape');
};
await step('Sheets: change and add cells, add a sheet; Show changes lists them', async () => {
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell('B1').waitFor();
  await nameCurrent('First quote');
  await cell('B1').dblclick(); await page.keyboard.press('Control+a'); await page.keyboard.type('=3*500'); await page.keyboard.press('Enter');
  await cell('A2').dblclick(); await page.keyboard.type('VAT'); await page.keyboard.press('Enter');
  await until(async () => (await cell('B1').innerText()).trim() === '1500');
  await page.getByRole('button', { name: 'Add sheet' }).click();
  await page.locator('.sheet-tab > button', { hasText: 'Sheet2' }).waitFor();
  await page.waitForTimeout(2600);
  await more(); await page.getByRole('menuitem', { name: 'Version history' }).click();
  await hist().getByRole('button', { name: /First quote/ }).click();
  await hist().getByLabel('Show changes since then').check();
  const body = hist().locator('.versions-body');
  await body.getByText('Since then: 2 cells changed, 1 sheet added, renamed or deleted.').waitFor();
  const rows = await body.getByRole('region', { name: 'Changes in Sheet1' }).locator('tbody tr').allInnerTexts();
  if (rows.map((r) => r.replace(/\s+/g, ' ').trim()).join(' | ') !== 'B1 =2*500 =3*500 | A2 (empty) VAT') throw new Error(rows.join(' | '));
  await body.getByRole('region', { name: 'Changes in Sheet2' }).getByText('new sheet').waitFor();
  await page.keyboard.press('Escape');
});
await step('Slides: change the title and add a slide; Show changes says what happened', async () => {
  await page.goto(`${B}/slides/${deckId}`);
  await page.getByText('Click to add title').waitFor();
  await nameCurrent('Draft');
  await page.getByText('Click to add title').dblclick();
  await page.keyboard.type('Our pitch');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'New slide' }).click();
  await page.getByRole('menuitem', { name: 'Title and text' }).click();
  await page.getByRole('button', { name: 'Slide 2', exact: true }).waitFor();
  await page.getByText('All changes saved').waitFor(); await page.waitForTimeout(2600);
  await more(); await page.getByRole('menuitem', { name: 'Version history' }).click();
  await hist().getByRole('button', { name: /Draft/ }).click();
  await hist().getByLabel('Show changes since then').check();
  const body = hist().locator('.versions-body');
  await body.getByText('Since then: 2 slides added, deleted, moved or changed.').waitFor();
  const one = body.getByRole('listitem', { name: 'Slide 1: Changed' });
  await one.getByText('Slide 1: Our pitch').waitFor();
  if ((await one.locator('ins').innerText()) !== '“Our pitch”') throw new Error(await one.innerText());
  await body.getByRole('listitem', { name: 'Slide 2: New slide' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
