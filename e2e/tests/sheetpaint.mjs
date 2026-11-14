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
const shownRows = (p) => p.locator('.grid-wrap tbody tr > th').allInnerTexts().then((l) => l.slice(0, 7).join(','));
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
  const cells = { A1: 'Job', B1: 'Status', C1: 'Cost', A2: 'Logo', B2: 'Done', C2: '40', A3: 'Site', B3: 'Open', C3: '250', A4: 'Ads', B4: 'Done', C4: '120', A5: 'Flyers', C5: '30' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Jobs', content: { sheets: [{ name: 'Sheet1', cells, formats: { A1: { b: true, fill: '#ffff00' }, B1: { i: true }, A3: { s: true } } }] } })).body.id;
  await api(page, 'PUT', `/files/${sheetId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/sheets/${sheetId}`); await cell(p, 'A5').getByText('Flyers').waitFor(); }
});
const fmts = async () => (await api(page, 'GET', `/files/${sheetId}/content`)).body.content.sheets[0].formats || {};
const brush = () => page.getByRole('button', { name: 'Paint format' });
await step('paint one cell\'s formatting onto a dragged range, for everyone', async () => {
  await cell(page, 'A1').click();
  await brush().click();
  if ((await brush().getAttribute('aria-pressed')) !== 'true') throw new Error('not on');
  await cell(page, 'C2').hover(); await page.mouse.down(); await cell(page, 'C4').hover(); await page.mouse.up();
  await until(async () => { const f = await fmts(); return ['C2', 'C3', 'C4'].every((k) => f[k]?.b && f[k]?.fill === '#ffff00'); });
  await until(async () => (await cell(kim, 'C3').evaluate((el) => getComputedStyle(el).fontWeight)) === '700');
  if ((await brush().getAttribute('aria-pressed')) !== 'false') throw new Error('one use');
  await page.screenshot({ path: `${SP}/shots/sheetpaint.png` });
});
await step('a block repeats; plain cells clear formatting; double-click keeps it on until Esc', async () => {
  await cell(page, 'A1').click(); await page.keyboard.press('Shift+ArrowRight');
  await brush().click();
  await cell(page, 'A5').hover(); await page.mouse.down(); await cell(page, 'D5').hover(); await page.mouse.up();
  await until(async () => { const f = await fmts(); return f.A5?.b && f.B5?.i && !f.B5?.b && f.C5?.b && f.D5?.i; });
  await cell(page, 'E9').click();
  await brush().dblclick();
  if ((await brush().getAttribute('aria-pressed')) !== 'true') throw new Error('not on');
  await cell(page, 'A3').click();
  await until(async () => !(await fmts()).A3);
  await cell(page, 'C3').click();
  await until(async () => !(await fmts()).C3);
  if ((await brush().getAttribute('aria-pressed')) !== 'true') throw new Error('should stay on');
  await page.keyboard.press('Escape');
  await until(async () => (await brush().getAttribute('aria-pressed')) === 'false');
  await cell(page, 'C4').click();
  await page.waitForTimeout(400);
  if (!(await fmts()).C4?.b) throw new Error('painted after Esc');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
