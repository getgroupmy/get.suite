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
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
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
  const cells = { A1: 'Task', B1: 'Due', A2: 'Invoice', B2: day(-3), A3: 'Call', B3: day(0), A4: 'Report', B4: day(5), A5: 'Audit', B5: day(30), A6: 'Note', B6: 'someday' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Orders', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell('B6').getByText('someday').waitFor();
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
const add = async (when, colour, date) => {
  const dlg = page.getByRole('dialog', { name: 'Conditional formatting' });
  if (!(await dlg.count())) await page.getByRole('button', { name: 'Conditional formatting', exact: true }).click();
  const more = dlg.getByRole('button', { name: 'Add a rule' });
  if (await more.count()) await more.click();
  await dlg.getByLabel('Apply to cells').fill('B2:B6');
  await dlg.getByLabel('When the value is').selectOption({ label: when });
  if (date) await dlg.getByLabel('Date', { exact: true }).fill(date);
  await dlg.getByRole('button', { name: colour, exact: true }).click();
  await dlg.getByRole('button', { name: 'Add rule' }).click();
  await dlg.getByRole('button', { name: 'Add a rule' }).waitFor();
};
await step('overdue in red, due today in blue, this week in yellow', async () => {
  await cell('B2').click();
  await add('Date is in the past', 'Red');
  await add('Date is today', 'Blue');
  await add('Date is in the next 7 days', 'Yellow');
  await page.screenshot({ path: `${SP}/shots/dates-dialog.png` });
  await page.keyboard.press('Escape');
  await until(async () => (await bg('B2')) === RED && (await bg('B3')) === 'rgb(232, 240, 254)' && (await bg('B4')) === 'rgb(254, 247, 224)');
  for (const k of ['B5', 'B6']) if (WHITE.indexOf(await bg(k)) < 0) throw new Error(`${k} coloured: ${await bg(k)}`);
  await page.screenshot({ path: `${SP}/shots/dates.png` });
});
await step('a date of your own: before a chosen day', async () => {
  await add('Date is before', 'Green', day(60));
  await page.getByRole('dialog', { name: 'Conditional formatting' }).getByText(`B2:B6 · Date is before ${day(60)}`).waitFor();
  await page.keyboard.press('Escape');
  await until(async () => (await bg('B5')) === GREEN);
  if (WHITE.indexOf(await bg('B6')) < 0) throw new Error('text is never a date');
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
