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
const rowH = (k) => cell(k).evaluate((td) => Math.round(td.parentElement.getBoundingClientRect().height));
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
  const cells = { A1: 'Quarterly revenue', B1: 'Headcount', C1: 'Region', A2: '120', B2: '14', C2: 'North' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Stats', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell('C2').getByText('North').waitFor();
});
await step('Rotate up turns the headings; the row grows to fit them', async () => {
  const before = await rowH('A1');
  await cell('A1').click();
  await page.keyboard.press('Shift+ArrowRight');
  await page.getByLabel('Text rotation').selectOption('up');
  await until(async () => (await cell('A1').locator('.cell-rot.rot-up').count()) === 1 && (await cell('B1').locator('.cell-rot.rot-up').count()) === 1);
  await until(async () => (await rowH('A1')) > before + 60);
  const wm = await cell('A1').locator('.cell-rot').evaluate((el) => getComputedStyle(el).writingMode);
  if (wm !== 'vertical-rl') throw new Error(wm);
  const f = await until(async () => (await api(page, 'GET', `/files/${sheetId}/content`)).body.content.sheets[0].formats?.B1);
  if (f.rot !== 'up') throw new Error(JSON.stringify(f));
});
await step('Tilt up leans one; None puts it back', async () => {
  await cell('C1').click();
  await page.getByLabel('Text rotation').selectOption('tiltup');
  await until(async () => (await cell('C1').locator('.cell-rot').evaluate((el) => getComputedStyle(el).transform)) !== 'none');
  await page.screenshot({ path: `${SP}/shots/textrot.png` });
  await page.getByLabel('Text rotation').selectOption('');
  await until(async () => (await cell('C1').locator('.cell-rot').count()) === 0);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
