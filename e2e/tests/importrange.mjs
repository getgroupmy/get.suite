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
let kim, src, secret;
await step('a colleague shares a spreadsheet to read from', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  src = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Rates', content: { sheets: [{ name: 'Sheet1', cells: { A1: '12', A2: '=A1+18' } }, { name: 'Price list', cells: { A1: 'Tea', B1: '3.5', A2: 'Cake', B2: '4' } }] } })).body;
  secret = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Salaries', content: { sheets: [{ name: 'Sheet1', cells: { A1: '99000' } }] } })).body;
  const s = await api(page, 'PUT', `/files/${src.id}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  if (s.status !== 200) throw new Error(JSON.stringify(s));
  kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
});
const cell = (k) => kim.locator(`.grid td[data-k="${k}"]`);
const typeIn = async (k, text) => { await cell(k).click(); await kim.keyboard.type(text); await kim.keyboard.press('Enter'); };
await step('IMPORTRANGE brings in cells from the shared spreadsheet', async () => {
  const mine = (await api(kim, 'POST', '/files/new', { kind: 'sheet', name: 'Summary' })).body;
  await kim.goto(`${B}/sheets/${mine.id}`);
  await cell('A1').waitFor();
  await typeIn('A1', `=SUM(IMPORTRANGE("${B}/sheets/${src.id}", "A1:A2"))`);
  await typeIn('A2', `=VLOOKUP("cake", IMPORTRANGE("${src.id}", "'Price list'!A1:B2"), 2, FALSE)`);
  await typeIn('A3', `=IMPORTRANGE("${secret.id}", "A1")`);
  await until(async () => (await cell('A1').innerText()).trim() === '42');
  await until(async () => (await cell('A2').innerText()).trim() === '4');
  await until(async () => (await cell('A3').innerText()).trim() === '#REF!');
}, kim);
await step('changes there show here on coming back to the tab', async () => {
  const cur = (await api(page, 'GET', `/files/${src.id}/content`)).body;
  const sheets = cur.content.sheets; sheets[0].cells.A1 = '20';
  const r = await api(page, 'PUT', `/files/${src.id}/content`, { version: cur.file.version, content: { sheets } });
  if (r.status !== 200) throw new Error(JSON.stringify(r).slice(0, 200));
  await kim.evaluate(() => window.dispatchEvent(new Event('focus')));
  await until(async () => (await cell('A1').innerText()).trim() === '58');
}, kim);
await step('typing the function shows what it takes', async () => {
  await cell('B1').click();
  await kim.keyboard.type('=IMPORTR');
  await kim.getByText('Cells from another spreadsheet you can open', { exact: false }).first().waitFor();
  await kim.keyboard.press('Escape');
}, kim);
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
