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
const typeIn = async (k, t) => { await cell(k).click(); await page.keyboard.type(t); await page.keyboard.press('Enter'); };
await step('HYPERLINK shows a label that opens its address; SPARKLINE draws a chart in the cell', async () => {
  const sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Links', content: { sheets: [{ name: 'Sheet1', cells: { B1: '3', B2: '7', B3: '4', B4: '9' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('A1').waitFor();
  await typeIn('A1', '=HYPERLINK("https://acme.example/orders", "Orders")');
  const a = cell('A1').getByRole('link', { name: 'Orders' });
  await a.waitFor();
  if ((await a.getAttribute('href')) !== 'https://acme.example/orders' || (await a.getAttribute('target')) !== '_blank') throw new Error('href');
  await typeIn('A2', '=HYPERLINK("javascript:alert(1)", "bad")');
  await cell('A2').getByText('#VALUE!').waitFor();
  if (await cell('A2').getByRole('link').count()) throw new Error('unsafe link shown');
  await typeIn('C1', '=SPARKLINE(B1:B4)');
  await cell('C1').getByRole('img', { name: 'Sparkline of 4 values' }).waitFor();
  if (!(await cell('C1').locator('polyline').count())) throw new Error('no line');
  await typeIn('C2', '=SPARKLINE(B1:B4, "column")');
  await until(async () => (await cell('C2').locator('rect').count()) === 4);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
