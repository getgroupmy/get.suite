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
const loaded = (p, k) => cell(p, k).locator('img.cell-img').evaluate((img) => img.complete && img.naturalWidth > 0 ? { w: Math.round(img.getBoundingClientRect().width), h: Math.round(img.getBoundingClientRect().height), nat: img.naturalWidth } : null).catch(() => null);
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
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Products', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Item', B1: 'Picture', A2: 'Mug', A3: 'Cap' } }] } })).body.id;
  await api(page, 'PUT', `/files/${sheetId}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/sheets/${sheetId}`); await cell(p, 'A3').getByText('Cap').waitFor(); }
});
await step('Insert picture in cell: upload one at its own size', async () => {
  await cell(page, 'B2').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Insert picture in cell…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Picture in cell B2' });
  await dlg.getByLabel('Its own size (the row grows)').check();
  await dlg.getByLabel('Picture file').setInputFiles(`${ROOT}/e2e/fixtures/blue.png`);
  await dlg.waitFor({ state: 'detached' });
  const got = await until(() => loaded(page, 'B2'));
  if (got.w !== 80 || got.h !== 40) throw new Error(JSON.stringify(got));
  const f = await until(async () => (await content()).sheets[0].cells.B2);
  if (!/^=IMAGE\("drive:[A-Za-z0-9_-]+", 3\)$/.test(f)) throw new Error(f);
  await page.screenshot({ path: `${SP}/shots/cellpic.png` });
});
await step('a viewer sees it too (the picture itself is not shared with them)', async () => {
  const got = await until(() => loaded(kim, 'B2'), 15000);
  if (got.nat !== 80) throw new Error(JSON.stringify(got));
});
await step('from Drive at a chosen size; the formula bar shows IMAGE', async () => {
  await cell(page, 'B3').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Insert picture in cell…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Picture in cell B3' });
  await dlg.getByLabel('A size I choose').check();
  await dlg.getByLabel('Height (pixels)').fill('30');
  await dlg.getByLabel('Width (pixels)').fill('60');
  await dlg.getByRole('button', { name: 'Choose from Drive' }).click();
  const pick = page.getByRole('dialog', { name: 'Picture from Drive' });
  await pick.getByText('blue.png').click();
  await until(async () => (await loaded(page, 'B3'))?.w === 60);
  if ((await loaded(page, 'B3')).h !== 30) throw new Error('height');
  await cell(page, 'B3').click();
  const bar = await page.locator('.formula-bar input:not(.cell-name), .formula-bar textarea').first().inputValue();
  if (!/^=IMAGE\("drive:.+", 4, 30, 60\)$/.test(bar)) throw new Error(bar);
  await until(async () => (await loaded(kim, 'B3'))?.w === 60);
});
await step('a typed IMAGE of a web address is refused', async () => {
  await cell(page, 'C2').click();
  await page.keyboard.type('=IMAGE("https://example.com/x.png")'); await page.keyboard.press('Enter');
  await until(async () => (await cell(page, 'C2').innerText()).includes('#VALUE!'));
  if (await cell(page, 'C2').locator('img').count()) throw new Error('no picture');
});
await step('a published copy shows the pictures to anyone', async () => {
  const path = (await api(page, 'PUT', `/publish/${sheetId}`, { on: true })).body.path;
  const anon = await mk('anon');
  await anon.goto(`${B}${path}`);
  await anon.locator('.pub-sheet td[data-k="B2"] img.cell-img').waitFor();
  await until(() => anon.locator('.pub-sheet td[data-k="B2"] img.cell-img').evaluate((img) => img.complete && img.naturalWidth === 80));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
