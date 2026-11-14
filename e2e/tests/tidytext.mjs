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
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const raw = async (id) => (await api(page, 'GET', `/files/${id}/content`)).body.content.sheets[0].cells;
let sheet;
await step('Trim whitespace: spaces at the ends and runs inside go, in the table around the cell; formulas stay', async () => {
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Customers', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: {
    A1: 'Name', B1: 'City', A2: '  ada   LOVELACE ', B2: 'kuala lumpur  ', A3: 'grace hopper', B3: '  new york', A4: '=UPPER(A3)', B4: '42', D1: '  far away  ' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('A2').waitFor();
  await cell('A2').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Trim whitespace' }).click();
  await page.getByText('Trimmed whitespace in 3 cells').waitFor();
  const c = await until(async () => { const x = await raw(sheet.id); return x.A2 === 'ada LOVELACE' ? x : null; }, 15000);
  if (c.A2 !== 'ada LOVELACE' || c.B2 !== 'kuala lumpur' || c.B3 !== 'new york' || c.A4 !== '=UPPER(A3)' || c.D1 !== '  far away  ') throw new Error(JSON.stringify(c));
});
await step('Change case: Title Case for a selection; Undo puts it back', async () => {
  await cell('A2').click();
  await cell('B3').click({ modifiers: ['Shift'] });
  await cell('B3').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Change case…' }).click();
  const d = page.getByRole('dialog', { name: 'Change case' });
  await page.screenshot({ path: `${SP}/shots/changecase.png` });
  await d.getByRole('button', { name: 'Title Case' }).click();
  await page.getByText('Changed 4 cells to Title Case').waitFor();
  await cell('A2').filter({ hasText: 'Ada Lovelace' }).waitFor();
  await cell('B2').filter({ hasText: 'Kuala Lumpur' }).waitFor();
  await cell('A4').filter({ hasText: 'GRACE HOPPER' }).waitFor(); // the formula sees the new text… and shows it in capitals
  await page.keyboard.press('Control+z');
  await cell('A2').filter({ hasText: 'ada LOVELACE' }).waitFor();
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
