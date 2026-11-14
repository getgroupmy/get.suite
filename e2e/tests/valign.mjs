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
let sheetId, kim;
const cell = (p, k) => p.locator(`[data-k="${k}"]`);
const content = async () => (await api(page, 'GET', `/files/${sheetId}/content`)).body.content;
const va = (p, k) => cell(p, k).evaluate((td) => getComputedStyle(td).verticalAlign);
const textTop = (p, k) => cell(p, k).evaluate((td) => { const r = document.createRange(); r.selectNodeContents(td); return Math.round(r.getBoundingClientRect().top - td.getBoundingClientRect().top); });
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
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Notes', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Topic', A2: 'Budget', B2: 'Agreed', C2: 'Later' }, rowHeights: { 2: 90 } }] } })).body.id;
  await api(page, 'PUT', `/files/${sheetId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/sheets/${sheetId}`); await cell(p, 'A2').getByText('Budget').waitFor(); }
});
await step('Top and Bottom place text in a tall row, for everyone', async () => {
  const mid = await textTop(page, 'A2');
  if (mid < 25) throw new Error('middle first: ' + mid);
  await cell(page, 'A2').click();
  await page.keyboard.press('Shift+ArrowRight');
  await page.getByLabel('Vertical alignment').selectOption('top');
  await until(async () => (await va(page, 'A2')) === 'top' && (await va(page, 'B2')) === 'top');
  if ((await textTop(page, 'A2')) > 8) throw new Error('text at the top');
  await until(async () => (await va(kim, 'B2')) === 'top');
  await cell(page, 'C2').click();
  await page.getByLabel('Vertical alignment').selectOption('bottom');
  await until(async () => (await textTop(page, 'C2')) > 55);
  const f = await until(async () => { const x = (await content()).sheets[0].formats; return x?.C2?.va === 'bottom' && x; });
  if (f.A2.va !== 'top' || f.B2.va !== 'top') throw new Error(JSON.stringify(f));
  await page.screenshot({ path: `${SP}/shots/valign.png` });
});
await step('the toolbar shows the cell’s setting; clear formatting resets it', async () => {
  await cell(page, 'A2').click();
  if ((await page.getByLabel('Vertical alignment').inputValue()) !== 'top') throw new Error('shows top');
  await page.getByRole('button', { name: 'Clear formatting' }).click();
  await until(async () => (await va(page, 'A2')) === 'middle');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
