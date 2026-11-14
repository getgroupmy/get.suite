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
  const cells = { A1: 'Region', B1: 'Rep', C1: 'Amount', A2: 'North', B2: 'Ana', C2: '120', A3: 'South', B3: 'Ben', C3: '80', A4: 'North', B4: 'Cleo', C4: '200', A5: 'East', B5: 'Dev', C5: '50' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Numbers', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell('B5').getByText('Dev').waitFor();
});
await step('QUERY totals each region into the cells beside it', async () => {
  await typeIn('E1', '=QUERY(A1:C5, "select A, sum(C) group by A order by sum(C) desc label sum(C) \'Total\'")');
  await cell('E1').getByText('Region').waitFor();
  const got = [];
  for (const k of ['E1', 'F1', 'E2', 'F2', 'E3', 'F3', 'E4', 'F4']) got.push((await cell(k).innerText()).trim());
  if (got.join('|') !== 'Region|Total|North|320|South|80|East|50') throw new Error(got.join('|'));
  await page.screenshot({ path: `${SP}/shots/query-spill.png` });
});
await step('it follows the data as it changes', async () => {
  await typeIn('C5', '500');
  await cell('E2').getByText('East').waitFor();
  await until(async () => (await cell('F2').innerText()).trim() === '500');
});
await step('a mistake in the query says what is wrong', async () => {
  await typeIn('H1', '=QUERY(A1:C5, "select Z")');
  await cell('H1').click();
  await page.getByText("There's no column Z in the data").waitFor();
});
await step('the function help knows QUERY', async () => {
  await cell('H3').click();
  await page.keyboard.type('=QUER');
  await page.getByText(/Picks, filters, groups and sorts/).first().waitFor();
  await page.keyboard.press('Escape');
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
