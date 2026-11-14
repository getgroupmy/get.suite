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
let sheetId, kim, vic;
const content = () => api(page, 'GET', `/files/${sheetId}/content`).then((r) => r.body.content.sheets[0]);
const width = (p, col) => p.locator('thead th', { hasText: new RegExp(`^${col}$`) }).evaluate((el) => el.getBoundingClientRect().width);

await step('setup: a long table shared with an editor and a viewer', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  for (const [local, name] of [['kim', 'Kim Park'], ['vic', 'Vic Viewer']]) await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
  const dir = (await api(page, 'GET', '/users/directory')).body;
  const idOf = (e) => dir.find((u) => u.username === e).id;
  const cells = { A1: 'Product', B1: 'Price' };
  for (let r = 2; r <= 80; r++) { cells[`A${r}`] = r === 5 ? 'An unusually long product description' : `Item ${r}`; cells[`B${r}`] = String(r * 3); }
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Prices', content: { sheets: [{ name: 'Sheet1', cells, colWidths: {} }] } })).body.id;
  await api(page, 'PUT', `/files/${sheetId}/shares`, { shares: [{ user_id: idOf('kim@acme.com'), role: 'editor' }, { user_id: idOf('vic@acme.com'), role: 'viewer' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  vic = await mk('vic'); await signIn(vic, 'vic@acme.com');
  for (const p of [page, kim, vic]) { await p.goto(`${B}/sheets/${sheetId}`); await p.locator('[data-k="A2"]', { hasText: 'Item 2' }).waitFor(); }
});

await step('drag a column edge to resize it; the others see the new width', async () => {
  const w0 = await width(page, 'B');
  const h = await page.getByLabel('Resize column B').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 80, h.y + h.height / 2, { steps: 6 });
  await page.mouse.up();
  await until(async () => Math.abs((await width(kim, 'B')) - (w0 + 80)) <= 2);
  await until(async () => (await content()).colWidths?.B === Math.round(w0 + 80) - 0 || Math.abs((await content()).colWidths?.B - (w0 + 80)) <= 2);
});

await step('double-click the edge to fit the column to its contents', async () => {
  await page.getByLabel('Resize column A').dblclick();
  await until(async () => (await width(kim, 'A')) > 200);
  const fits = await kim.locator('[data-k="A5"]').evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  if (!fits) throw new Error('the long text still does not fit');
});

await step('freeze the first row and column: they stay in view while scrolling', async () => {
  await page.locator('tbody th', { hasText: /^1$/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Freeze the first row' }).click();
  await page.locator('thead th', { hasText: /^A$/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Freeze the first column' }).click();
  await until(async () => (await content()).frozen?.rows === 1 && (await content()).frozen?.cols === 1);
  for (const p of [kim, vic]) {
    await until(() => p.locator('[data-k="A1"]').evaluate((el) => el.classList.contains('frozen-r') && el.classList.contains('frozen-c')));
    const grid = p.locator('.grid-wrap');
    const before = await p.locator('[data-k="A1"]').boundingBox();
    await grid.evaluate((el) => { el.scrollTop = 1200; el.scrollLeft = 900; });
    await p.waitForTimeout(150);
    const after = await p.locator('[data-k="A1"]').boundingBox();
    if (Math.abs(after.y - before.y) > 1 || Math.abs(after.x - before.x) > 1) throw new Error(`A1 moved: ${JSON.stringify([before, after])}`);
    const b1 = await p.locator('[data-k="B1"]').boundingBox(), a40 = await p.locator('[data-k="A40"]').boundingBox();
    if (Math.abs(b1.y - before.y) > 1) throw new Error('the first row scrolled away');
    if (Math.abs(a40.x - before.x) > 1) throw new Error('the first column scrolled away');
  }
  await kim.screenshot({ path: `${SP}/shots/sheetview.png` });
});

await step('unfreeze; viewers cannot resize', async () => {
  await page.locator('tbody th', { hasText: /^1$/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Unfreeze rows' }).click();
  await until(async () => !(await kim.locator('[data-k="A1"]').evaluate((el) => el.classList.contains('frozen-r'))));
  if (await vic.getByLabel('Resize column A').count()) throw new Error('viewer can resize');
});

await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
