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
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const rowHead = (n) => page.locator('.grid tbody th', { hasText: new RegExp(`^${n}`) }).first();
let sheet;
const groupsNow = async () => (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content.sheets[0].groups || null;
await step('group rows 2–4 from the row menu, collapse and expand them', async () => {
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Income', A2: 'Rent', A3: 'Sales', A4: 'Fees', A5: 'Total' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('A1').waitFor();
  await rowHead(2).click();
  await rowHead(4).click({ modifiers: ['Shift'] });
  await rowHead(4).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Group rows 2–4', exact: true }).click();
  await until(async () => JSON.stringify(await groupsNow()) === '[{"axis":"row","from":1,"to":3,"collapsed":false}]');
  await page.getByRole('button', { name: 'Collapse rows 2–4' }).click();
  await until(async () => !(await cell('A3').count()));
  await cell('A5').waitFor();
  await until(async () => (await groupsNow())?.[0].collapsed === true);
  await page.getByRole('button', { name: 'Expand rows 2–4' }).click();
  await cell('A3').waitFor();
});
await step('group columns, and ungroup', async () => {
  await page.locator('.grid thead th', { hasText: /^B/ }).first().click();
  await page.locator('.grid thead th', { hasText: /^C/ }).first().click({ modifiers: ['Shift'] });
  await page.locator('.grid thead th', { hasText: /^C/ }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Group columns B–C', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse columns B–C' }).click();
  await until(async () => (await groupsNow())?.find((g) => g.axis === 'col')?.collapsed === true);
  await page.getByRole('button', { name: 'Expand columns B–C' }).click();
  await rowHead(3).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Ungroup rows' }).click();
  await until(async () => JSON.stringify((await groupsNow()) || []).indexOf('"row"') < 0);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
