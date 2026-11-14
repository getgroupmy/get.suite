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
  const cells = { A1: 'Name', B1: 'Email', C1: 'Score', A2: 'Ana', B2: 'ana@acme.com', C2: '72', A3: 'Bo', B3: 'bo@north.org', C3: '91', A4: 'Cy', B4: 'cy@acme.com', C4: '58' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Class', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell('C3').getByText('91').waitFor();
});
await step('suggestions and help know the new functions', async () => {
  await cell('E1').click();
  await page.keyboard.type('=textaf');
  const list = page.getByRole('listbox', { name: 'Function suggestions' });
  await list.waitFor();
  const names = await list.getByRole('option').locator('b').allInnerTexts();
  if (!names.includes('TEXTAFTER')) throw new Error(names.join(','));
  await page.keyboard.press('Tab');
  const help = page.getByRole('status', { name: 'Function help' });
  if (!(await help.innerText()).includes('The text after a delimiter')) throw new Error(await help.innerText());
  await page.keyboard.type('B2, "@")');
  await page.keyboard.press('Enter');
  await until(async () => (await cell('E1').innerText()) === 'acme.com');
});
await step('results spill: SORTBY, TEXTSPLIT, CHOOSECOLS, FREQUENCY, ROMAN, DEC2BIN', async () => {
  await typeIn('G1', '=SORTBY(A2:A4, C2:C4, -1)');
  await until(async () => (await cell('G1').innerText()) === 'Bo' && (await cell('G3').innerText()) === 'Cy');
  await typeIn('H1', '=TEXTSPLIT("red,green;blue,grey", ",", ";")');
  await until(async () => (await cell('I2').innerText()) === 'grey');
  await typeIn('A7', '=CHOOSECOLS(A1:C4, 1, -1)');
  await until(async () => (await cell('B10').innerText()) === '58');
  await typeIn('E7', '=FREQUENCY(C2:C4, {60;80})'.replace('{60;80}', 'D12:D13'));
  await typeIn('D12', '60'); await typeIn('D13', '80');
  await until(async () => [await cell('E7').innerText(), await cell('E8').innerText(), await cell('E9').innerText()].join() === '1,1,1');
  await typeIn('F12', '=ROMAN(2026)');
  await typeIn('F13', '=DEC2BIN(10, 8)');
  await typeIn('F14', '=TEXTBEFORE(B3, "@")');
  await until(async () => (await cell('F12').innerText()) === 'MMXXVI' && (await cell('F13').innerText()) === '00001010' && (await cell('F14').innerText()) === 'bo');
  await page.screenshot({ path: `${SP}/shots/morefuncs.png` });
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
