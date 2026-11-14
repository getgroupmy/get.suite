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
const text = async (k) => (await cell(page, k).innerText()).trim();
const type = async (k, v) => { await cell(page, k).click(); await page.keyboard.type(v); await page.keyboard.press('Enter'); };
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
  const cells = { A1: 'Ordered', B1: 'Due', C1: 'Days', A2: '2026-11-09', A3: '2026-12-20' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Orders', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell(page, 'A1').getByText('Ordered').waitFor();
});
await step('a date plus days is a date; a date minus a date is the days between', async () => {
  await type('B2', '=A2+30');
  await until(async () => (await text('B2')) === '2026-12-09');
  await type('C2', '=B2-A2');
  await until(async () => (await text('C2')) === '30');
  await type('B3', '=A3+0.5');
  await until(async () => (await text('B3')) === '2026-12-20 12:00');
  await type('D2', '=MAX(A2:A3)');
  await until(async () => (await text('D2')) === '2026-12-20');
});
await step('fill down follows, and a date format shows them nicely', async () => {
  await cell(page, 'B2').click();
  await page.keyboard.press('Control+c');
  await cell(page, 'B3').click();
  await page.keyboard.press('Control+v');
  await until(async () => (await text('B3')) === '2027-01-19');
  await cell(page, 'B2').click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.getByLabel('Number format').selectOption('custom');
  const dlg = page.getByRole('dialog', { name: 'Custom number format' });
  await dlg.getByLabel('Format code').fill('ddd d mmm');
  await dlg.getByRole('button', { name: 'Apply' }).click();
  await until(async () => (await text('B2')) === 'Wed 9 Dec' && (await text('B3')) === 'Tue 19 Jan');
  await page.screenshot({ path: `${SP}/shots/datemath.png` });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
