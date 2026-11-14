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
const cell = (p, k) => p.locator(`[data-k="${k}"]`);
await step('setup: a budget and last year\'s CSV export', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget 2026', content: { sheets: [
    { name: 'Costs', cells: { A1: 'Rent', B1: '1200', A2: 'Power', B2: '300', A3: 'Total', B3: '=SUM(B1:B2)' } },
    { name: 'Notes', cells: { A1: 'Draft' } },
  ] } })).body.id;
  const status = await page.evaluate(async () => (await fetch('/api/files/upload?name=Budget%202025.csv', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: 'Rent,1100\nPower,300\nTotal,1400\n' })).status);
  if (status !== 201 && status !== 200) throw new Error('upload ' + status);
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell(page, 'B3').getByText('1500').waitFor();
});
const open = async () => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Compare spreadsheets' }).click();
  const pick = page.getByRole('dialog', { name: 'Compare with…' });
  await pick.getByRole('button', { name: /Budget 2025\.csv/ }).click();
  return page.getByRole('dialog', { name: 'Compare spreadsheets' });
};
const rows = (dlg) => dlg.locator('.changes-table tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((x) => x.textContent).join('|')));
await step('Compare with a CSV: results cell by cell', async () => {
  const dlg = await open();
  await dlg.getByText('From Budget 2026 to Budget 2025.csv').waitFor();
  const t = await dlg.getByRole('status').innerText();
  if (!/^2 cells differ; 2 sheets only in one of them, or named differently\.$/.test(t)) throw new Error(t);
  const r = await rows(dlg);
  if (JSON.stringify(r) !== JSON.stringify(['B1|1200|1100', 'B3|1500|1400'])) throw new Error(JSON.stringify(r));
  await dlg.getByRole('columnheader', { name: 'Budget 2025.csv' }).first().waitFor();
  await dlg.getByText('only in Budget 2026').waitFor(); // the Notes sheet
});
await step('Formulas as typed, and the other way round', async () => {
  const dlg = page.getByRole('dialog', { name: 'Compare spreadsheets' });
  await dlg.getByRole('radio', { name: 'Formulas' }).click();
  await until(async () => (await rows(dlg)).includes('B3|=SUM(B1:B2)|1400'));
  await dlg.getByRole('button', { name: '⇄ Swap' }).click();
  await dlg.getByText('From Budget 2025.csv to Budget 2026').waitFor();
  await until(async () => (await rows(dlg)).includes('B1|1100|1200'));
  await dlg.getByText('only in Budget 2026').waitFor();
  await dlg.getByText('(called Budget 2025 in Budget 2025.csv)').waitFor();
  await page.screenshot({ path: `${SP}/shots/sheetcompare.png` });
  await dlg.getByRole('button', { name: 'Done' }).click();
});
await step('What you just typed counts; the same results say so', async () => {
  await cell(page, 'B1').click();
  await page.keyboard.type('1100');
  await page.keyboard.press('Enter');
  await cell(page, 'B3').getByText('1400').waitFor();
  const dlg = await open();
  const t = await dlg.getByRole('status').innerText();
  if (!/^0 cells differ; 2 sheets/.test(t)) throw new Error(t);
  if ((await rows(dlg)).length) throw new Error('rows left');
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
