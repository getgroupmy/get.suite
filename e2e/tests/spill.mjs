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
await step('a formula giving several values spills into the cells below', async () => {
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Spill', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Tea', B1: '3', A2: 'Cake', B2: '12', A3: 'tea', B3: '8', A4: 'Pie', B4: '15' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('A1').waitFor();
  await typeIn('D1', '=FILTER(A1:B4, B1:B4>5)');
  await until(async () => (await text('D1')) === 'Cake' && (await text('E3')) === '15' && (await text('D3')) === 'Pie');
  if ((await cell('D2').getAttribute('title')) !== 'From the formula in D1') throw new Error('title ' + await cell('D2').getAttribute('title'));
  const c = (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content.sheets[0].cells;
  if (c.D2 !== undefined || c.E3 !== undefined) throw new Error('spilled cells are not saved');
});
await step('typing in the way shows #SPILL!, clearing it spills again', async () => {
  await typeIn('D3', 'busy');
  await until(async () => (await text('D1')) === '#SPILL!');
  await cell('D3').click();
  await page.keyboard.press('Delete');
  await until(async () => (await text('D1')) === 'Cake' && (await text('D3')) === 'Pie');
});
await step('SEQUENCE, UNIQUE and SORT, and sums of them', async () => {
  await typeIn('G1', '=SEQUENCE(30)');
  await until(async () => (await text('G30')) === '30');
  await typeIn('H1', '=SUM(G1:G30)');
  await until(async () => (await text('H1')) === '465');
  await typeIn('I1', '=UNIQUE(A1:A4)');
  await until(async () => (await text('I3')) === 'Pie' && (await text('I4')) === '');
  await typeIn('J1', '=SORT(B1:B4, 1, -1)');
  await until(async () => (await text('J1')) === '15' && (await text('J4')) === '3');
  await typeIn('K1', '=B1:B4*2');
  await until(async () => (await text('K4')) === '30');
});
await step('the CSV download includes spilled cells', async () => {
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: /More|⋮/ }).first().click();
  await page.getByRole('menuitem', { name: 'Download sheet as CSV' }).click();
  const d = await dl;
  const csv = (await (await import('node:fs/promises')).readFile(await d.path(), 'utf8')).split('\n');
  if (csv.length < 30 || !csv[29].includes('30')) throw new Error(csv.slice(0, 3).join('|') + ' … ' + csv.length);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
