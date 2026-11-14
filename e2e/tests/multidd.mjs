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
let kim;
const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
let sheetId;
const cell = (p, k) => p.locator(`[data-k="${k}"]`);
const content = () => api(page, 'GET', `/files/${sheetId}/content`).then((r) => r.body.content.sheets[0]);
await step('a dropdown allowing several choices in a cell, made in Data validation', async () => {
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Team', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Name', B1: 'Skills', A2: 'Ann', A3: 'Ben', A4: 'Cat' } }] } })).body.id;
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell(page, 'A2').getByText('Ann').waitFor();
  await cell(page, 'B2').click();
  await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowDown');
  await page.getByRole('button', { name: 'Data validation' }).click();
  const dlg = page.getByRole('dialog', { name: 'Data validation' });
  await dlg.getByLabel('Choices (one per line, or separated by commas)').fill('Design\nMarketing\nSales');
  await dlg.getByLabel('Allow several choices in a cell').check();
  await dlg.getByText('Colours').click();
  await dlg.getByLabel('Colour for Design').selectOption({ label: 'Green' });
  await dlg.getByRole('button', { name: 'Add' }).click();
  await dlg.getByText(/several choices per cell/).waitFor();
  await page.keyboard.press('Escape');
  const v = await until(async () => (await content()).validations?.[0]);
  if (!v.multi || v.values.join() !== 'Design,Marketing,Sales') throw new Error(JSON.stringify(v));
});
await step('pick two from the list (it stays open), each shown as its own chip', async () => {
  await cell(page, 'B2').getByRole('button', { name: 'Choices for B2' }).click();
  const list = page.getByRole('listbox', { name: 'Choices' });
  await list.getByRole('option', { name: /Design/ }).click();
  await list.getByRole('option', { name: /Sales/ }).click();
  await until(async () => (await content()).cells.B2 === 'Design, Sales');
  if (await list.getByRole('option', { name: /Design/ }).getAttribute('aria-checked') !== 'true') throw new Error('ticked');
  await page.keyboard.press('Escape');
  const chips = cell(page, 'B2').locator('.cell-chip');
  await until(async () => (await chips.count()) === 2);
  if ((await chips.allInnerTexts()).join('|') !== 'Design|Sales') throw new Error(await chips.allInnerTexts());
  if (await chips.first().evaluate((e) => getComputedStyle(e).backgroundColor) !== 'rgb(206, 234, 214)') throw new Error('colour');
  // Taking one off.
  await cell(page, 'B2').getByRole('button', { name: 'Choices for B2' }).click();
  await list.getByRole('option', { name: /Design/ }).click();
  await until(async () => (await content()).cells.B2 === 'Sales');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${SP}/shots/multi-chips.png` });
});
await step('typing: each part checked and spelled as the choices; others refused', async () => {
  await cell(page, 'B3').click();
  await page.keyboard.type('marketing, design');
  await page.keyboard.press('Enter');
  await until(async () => (await content()).cells.B3 === 'Marketing, Design');
  await cell(page, 'B4').click();
  await page.keyboard.type('Design, Legal');
  await page.keyboard.press('Enter');
  await page.getByText(/Not a choice: Legal/).first().waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
