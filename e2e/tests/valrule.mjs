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
const RED_ = 'rgb(252, 232, 230)', GREEN = 'rgb(230, 244, 234)', WHITE = ['rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)'];
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
const openDlg = async () => {
  await page.getByRole('button', { name: 'Data validation', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Data validation' });
  await dlg.waitFor();
  await page.waitForTimeout(200);
  if (!(await dlg.getByLabel('Cells').count())) await dlg.getByRole('button', { name: 'Add', exact: true }).click();
  return dlg;
};
const marked = (k) => cell(k).evaluate((el) => el.classList.contains('invalid'));
await step('a whole number from 1 to 999: anything else is refused', async () => {
  await cell('B2').click();
  const dlg = await openDlg();
  await dlg.getByLabel('Cells').fill('B2:B6');
  await dlg.getByRole('radio', { name: 'Rule' }).click();
  await dlg.getByLabel('Allow').selectOption({ label: 'Whole number' });
  await dlg.getByLabel('From').fill('1');
  await dlg.getByLabel('To', { exact: true }).fill('999');
  await dlg.getByLabel(/Message when a value/).fill('A total from 1 to 999');
  await page.screenshot({ path: `${SP}/shots/valrule-form.png` });
  await dlg.getByRole('button', { name: 'Add', exact: true }).click();
  await dlg.getByText('Whole number between 1 and 999').waitFor();
  await page.keyboard.press('Escape');
  await typeIn('B3', '2.5');
  await page.locator('.toast', { hasText: 'A total from 1 to 999' }).last().waitFor();
  await page.keyboard.press('Escape'); // it stays in the cell to fix; Escape gives up
  await until(async () => (await cell('B3').innerText()) === '40');
  await typeIn('B3', '45');
  await until(async () => (await cell('B3').innerText()) === '45');
});
await step('a date after a day, kept with a warning and marked', async () => {
  await cell('D2').click();
  const dlg = await openDlg();
  await dlg.getByLabel('Cells').fill('D2:D6');
  await dlg.getByRole('radio', { name: 'Rule' }).click();
  await dlg.getByLabel('Allow').selectOption({ label: 'Date' });
  await dlg.getByLabel('That is').selectOption({ label: 'after' });
  await dlg.getByLabel('Value', { exact: true }).fill('2026-01-01');
  await dlg.getByLabel(/Keep it, with a warning/).check();
  await dlg.getByRole('button', { name: 'Add', exact: true }).click();
  await dlg.getByText('Date after 2026-01-01 (other values marked)').waitFor();
  await page.keyboard.press('Escape');
  await typeIn('D2', '2025-06-01');
  await page.locator('.toast', { hasText: 'date after 2026-01-01' }).last().waitFor();
  await until(async () => (await cell('D2').innerText()) === '2025-06-01' && (await marked('D2')));
  await typeIn('D3', '2026-03-01');
  await until(async () => (await cell('D3').innerText()) === '2026-03-01');
  if (await marked('D3')) throw new Error('a fine date is not marked');
  if ((await cell('D2').getAttribute('title')) !== 'Not valid: Date after 2026-01-01') throw new Error(await cell('D2').getAttribute('title'));
  await page.screenshot({ path: `${SP}/shots/valrule.png` });
  const n = await page.locator('.toast', { hasText: 'date after 2026-01-01' }).count();
  if (n !== 1) throw new Error(`the warning showed ${n} times`);
});
await step('a custom formula marks the rows that break it', async () => {
  await typeIn('E1', 'Limit'); await typeIn('E2', '250');
  await cell('B2').click();
  const dlg = await openDlg();
  await dlg.getByLabel('Cells').fill('C2:C6');
  await dlg.getByRole('radio', { name: 'Rule' }).click();
  await dlg.getByLabel('Allow').selectOption({ label: 'Custom formula is TRUE' });
  await dlg.getByLabel('Formula', { exact: true }).fill('=C2<>"late"');
  await dlg.getByRole('button', { name: 'Add', exact: true }).click();
  await page.keyboard.press('Escape');
  await until(async () => (await marked('C3')) && (await marked('C5')));
  if (await marked('C2')) throw new Error('paid is fine');
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
