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
  const cells = { A1: 'Month', B1: 'Sales', A2: 'Jan', B2: '100', A3: 'Feb', B3: '150', A4: 'Mar', B4: '120', A5: 'Apr', B5: '200', D1: 'Last', D2: '3' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Sales', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell('B5').getByText('200').waitFor();
});
await step('OFFSET: the last few months, spilled and summed', async () => {
  await cell('F1').click();
  await page.keyboard.type('=offs');
  await page.getByRole('listbox', { name: 'Function suggestions' }).waitFor();
  await page.keyboard.press('Tab');
  const help = page.getByRole('status', { name: 'Function help' });
  if (!(await help.innerText()).includes('rows down and columns across')) throw new Error(await help.innerText());
  await page.keyboard.type('B1, COUNT(B2:B100) - D2 + 1, 0, D2)');
  await page.keyboard.press('Enter');
  await until(async () => [await cell('F1').innerText(), await cell('F2').innerText(), await cell('F3').innerText()].join() === '150,120,200');
  await typeIn('G1', '=SUM(OFFSET(B1, COUNT(B2:B100) - D2 + 1, 0, D2))');
  await until(async () => (await cell('G1').innerText()) === '470');
  await typeIn('D2', '2');
  await until(async () => (await cell('G1').innerText()) === '320' && (await cell('F1').innerText()) === '120' && (await cell('F3').innerText()) === '');
});
await step('INDIRECT follows text in another cell', async () => {
  await typeIn('H1', '=INDIRECT("B" & (D2 + 1))');
  await until(async () => (await cell('H1').innerText()) === '150');
  await typeIn('D2', '4');
  await until(async () => (await cell('H1').innerText()) === '200' && (await cell('G1').innerText()) === '570');
  await page.screenshot({ path: `${SP}/shots/offset.png` });
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
