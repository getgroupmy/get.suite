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
const text = async (k) => (await cell(k).innerText()).trim();
const typeIn = async (k, t) => { await cell(k).click(); await page.keyboard.type(t); await page.keyboard.press('Enter'); };
let sheet;
await step('pattern, split and stacking functions work as typed, and spill', async () => {
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Funcs', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Order INV-2041 paid', A2: 'kim@acme.com; ola@acme.com', A3: '-100', A4: '30', A5: '40', A6: '50' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('A1').waitFor();
  await typeIn('B1', '=REGEXEXTRACT(A1, "INV-\\d+")');
  await until(async () => (await text('B1')) === 'INV-2041');
  await typeIn('C1', '=REGEXMATCH(A1, "paid$")');
  await until(async () => (await text('C1')) === 'TRUE');
  await typeIn('B2', '=SPLIT(A2, "; ", FALSE)');
  await until(async () => (await text('B2')) === 'kim@acme.com' && (await text('C2')) === 'ola@acme.com');
  await typeIn('E1', '=VSTACK(A4:A5, A6)');
  await until(async () => (await text('E1')) === '30' && (await text('E3')) === '50');
});
await step('times, week numbers, cash flows and where cells are', async () => {
  await typeIn('F1', '=HOUR("2:45 PM")&":"&MINUTE("2:45 PM")');
  await until(async () => (await text('F1')) === '14:45');
  await typeIn('F2', '=ISOWEEKNUM("2026-12-28")');
  await until(async () => (await text('F2')) === '53');
  await typeIn('F3', '=ROUND(IRR(A3:A6), 3)');
  await until(async () => (await text('F3')) === '0.089');
  await typeIn('F4', '=ROW()*10+COLUMN()');
  await until(async () => (await text('F4')) === '46');
  await typeIn('F5', '=CHOOSE(2, "low", "mid", "high")');
  await until(async () => (await text('F5')) === 'mid');
});
await step('typing shows the new functions with their help', async () => {
  await cell('G1').click();
  await page.keyboard.type('=REGEX');
  await page.getByText('REGEXEXTRACT', { exact: true }).first().waitFor();
  await page.getByText('REGEXMATCH', { exact: true }).first().waitFor();
  await page.keyboard.press('Escape');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
