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

const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
let sheetId, kim;
const width = (p, col) => p.locator('thead th', { hasText: new RegExp(`^${col}$`) }).evaluate((el) => el.getBoundingClientRect().width);
const content = () => api(page, 'GET', `/files/${sheetId}/content`).then((r) => r.body.content.sheets[0]);
await step('zoom a spreadsheet: bigger cells; clicking, typing and resizing still land right', async () => {
  const cells = { A1: 'Product', B1: 'Price' };
  for (let r = 2; r <= 30; r++) { cells[`A${r}`] = `Item ${r}`; cells[`B${r}`] = String(r * 3); }
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Prices', content: { sheets: [{ name: 'Sheet1', cells, colWidths: {} }] } })).body.id;
  await page.goto(`${B}/sheets/${sheetId}`);
  await page.locator('[data-k="A2"]', { hasText: 'Item 2' }).waitFor();
  const w100 = await width(page, 'B');
  await page.getByLabel('Zoom').selectOption('150');
  await until(async () => Math.abs((await width(page, 'B')) - w100 * 1.5) < 2);
  // A click picks the cell under the mouse.
  await page.locator('[data-k="B6"]').click();
  await page.keyboard.type('999');
  await page.keyboard.press('Enter');
  await until(async () => (await content()).cells.B6 === '999');
  // The fill handle sits on the selection's corner.
  await page.locator('[data-k="B4"]').click();
  const td = await page.locator('[data-k="B4"]').boundingBox();
  const fh = await page.locator('.fill-handle').boundingBox();
  if (Math.abs((fh.x + fh.width / 2) - (td.x + td.width)) > 8 || Math.abs((fh.y + fh.height / 2) - (td.y + td.height)) > 8) throw new Error(`handle ${JSON.stringify(fh)} cell ${JSON.stringify(td)}`);
  await page.screenshot({ path: `${SP}/shots/sheet-zoom.png` });
  // Dragging a column edge 90 px on screen at 150% widens it by 60 px.
  const w0 = (await content()).colWidths?.B || w100;
  const h = await page.getByLabel('Resize column B').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 90, h.y + h.height / 2, { steps: 6 });
  await page.mouse.up();
  await until(async () => Math.abs(((await content()).colWidths?.B || 0) - (w0 + 60)) <= 3);
});
await step('dragging a chart at 150% moves it by the grid’s own distance', async () => {
  await page.goto(`${B}/drive`);
  await page.waitForTimeout(500);
  const cur = (await api(page, 'GET', `/files/${sheetId}/content`)).body;
  const sh = cur.content.sheets[0];
  sh.charts = { c1: { type: 'column', range: 'A1:B6', title: 'Prices chart', x: 300, y: 40, w: 360, h: 220 } };
  await api(page, 'PUT', `/files/${sheetId}/content`, { version: cur.file.version, content: cur.content });
  await page.goto(`${B}/sheets/${sheetId}`);
  const head = page.getByRole('region', { name: 'Chart: Prices chart' }).locator('.chart-head');
  await head.waitFor();
  const b = await head.boundingBox();
  await page.mouse.move(b.x + 30, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 30 + 90, b.y + b.height / 2 + 45, { steps: 6 });
  await page.mouse.up();
  await until(async () => { const c = (await content()).charts?.c1; return c && Math.abs(c.x - 360) <= 3 && Math.abs(c.y - 70) <= 3; });
});
await step('the zoom stays for you in every spreadsheet; others have their own', async () => {
  const other = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Other' })).body.id;
  await page.goto(`${B}/sheets/${other}`);
  await until(async () => (await page.getByLabel('Zoom').inputValue()) === '150');
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const dir = (await api(page, 'GET', '/users/directory')).body;
  await api(page, 'PUT', `/files/${sheetId}/shares`, { shares: [{ user_id: dir.find((u) => u.username === 'kim@acme.com').id, role: 'viewer' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/sheets/${sheetId}`);
  await kim.locator('[data-k="A2"]', { hasText: 'Item 2' }).waitFor();
  await kim.waitForTimeout(600);
  if (await kim.getByLabel('Zoom').inputValue() !== '100') throw new Error('Kim at 100%');
  // Docs keep their own zoom.
  const prefs = (await api(page, 'GET', '/doc-prefs')).body;
  if (prefs.sheet_zoom !== 150 || prefs.zoom !== 100) throw new Error(JSON.stringify(prefs));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
