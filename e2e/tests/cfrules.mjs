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
  const cells = { A1: 'Customer', B1: 'Total', C1: 'Status', A2: 'Acme', B2: '120', C2: 'paid', A3: 'Birch', B3: '40', C3: 'late', A4: 'acme', B4: '300', C4: 'paid', A5: 'Cedar', B5: '75', C5: 'late', A6: 'Dune', B6: '210', C6: 'paid' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Orders', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell('B6').getByText('210').waitFor();
});
const bg = (k) => cell(k).evaluate((el) => getComputedStyle(el).backgroundColor);
const RED = 'rgb(252, 232, 230)', GREEN = 'rgb(230, 244, 234)', WHITE = ['rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)'];
const addRule = async (range, when, value, colour) => {
  const dlg = page.getByRole('dialog', { name: 'Conditional formatting' });
  if (!(await dlg.count())) { await page.getByRole('button', { name: 'Conditional formatting', exact: true }).click(); }
  await dlg.waitFor();
  const add = dlg.getByRole('button', { name: 'Add a rule' });
  if (await add.count()) await add.click();
  await dlg.getByLabel('Apply to cells').fill(range);
  await dlg.getByLabel('When the value is').selectOption({ label: when });
  if (when === 'Custom formula is') await dlg.getByLabel('Formula', { exact: true }).fill(value);
  else if (value) await dlg.getByLabel('How many', { exact: true }).fill(value);
  await dlg.getByRole('button', { name: colour, exact: true }).click();
  await dlg.getByRole('button', { name: 'Add rule' }).click();
  await dlg.getByRole('button', { name: 'Add a rule' }).waitFor();
};
await step('duplicate values colour the repeats (any case)', async () => {
  await cell('A2').click();
  await addRule('A2:A6', 'Duplicate values', '', 'Red');
  await page.keyboard.press('Escape');
  await until(async () => (await bg('A2')) === RED && (await bg('A4')) === RED);
  if (WHITE.indexOf(await bg('A3')) < 0) throw new Error('Birch is not a duplicate: ' + await bg('A3'));
});
await step('top 2 and a custom formula for whole rows', async () => {
  await addRule('B2:B6', 'Top (how many)', '2', 'Green');
  await page.getByRole('dialog', { name: 'Conditional formatting' }).getByText('B2:B6 · Top 2').waitFor();
  await addRule('A2:C6', 'Custom formula is', '=$C2="late"', 'Yellow');
  await page.screenshot({ path: `${SP}/shots/rules-dialog.png` });
  await page.keyboard.press('Escape');
  await until(async () => (await bg('B4')) === GREEN && (await bg('B6')) === GREEN);
  if ((await bg('B2')) === GREEN) throw new Error('120 is not in the top 2');
  const YELLOW = 'rgb(254, 247, 224)';
  await until(async () => (await bg('A3')) === YELLOW && (await bg('C5')) === YELLOW && (await bg('B3')) === YELLOW);
  if ((await bg('C2')) === YELLOW) throw new Error('paid rows stay plain');
  await page.screenshot({ path: `${SP}/shots/rules.png` });
});
await step('the colours follow the values as they change', async () => {
  await cell('C2').click(); await page.keyboard.type('late'); await page.keyboard.press('Enter');
  await until(async () => (await bg('B2')) === 'rgb(254, 247, 224)');
  await cell('B3').click(); await page.keyboard.type('500'); await page.keyboard.press('Enter');
  await until(async () => (await bg('B6')) !== GREEN);
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
