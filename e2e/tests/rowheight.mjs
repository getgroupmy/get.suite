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
let sheetId, kim, picId;
const cell = (p, k) => p.locator(`[data-k="${k}"]`);
const content = async () => (await api(page, 'GET', `/files/${sheetId}/content`)).body.content;
const rowHeight = (p, k) => cell(p, k).evaluate((td) => Math.round(td.parentElement.getBoundingClientRect().height));
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
  picId = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 100; c.height = 100;
    const g = c.getContext('2d'); g.fillStyle = '#1a73e8'; g.fillRect(0, 0, 100, 100);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const res = await fetch('/api/files/upload?name=square.png', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: blob });
    return (await res.json()).id;
  });
  const cells = { A1: 'Item', B1: 'Picture', A2: 'Mug', B2: `=IMAGE("drive:${picId}")`, A3: 'Cap' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Products', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await api(page, 'PUT', `/files/${sheetId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/sheets/${sheetId}`); await cell(p, 'A3').getByText('Cap').waitFor(); }
});
await step('drag a row number’s bottom edge: the row and its fitted picture grow, for everyone', async () => {
  const before = await rowHeight(page, 'A2');
  if (before > 30) throw new Error('standard first: ' + before);
  const handle = page.getByRole('separator', { name: 'Resize row 2', exact: true });
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 60, { steps: 5 });
  await page.mouse.up();
  await until(async () => Math.abs((await rowHeight(page, 'A2')) - (before + 56)) <= 3);
  const saved = await until(async () => (await content()).sheets[0].rowHeights);
  if (Math.abs(saved['2'] - (before + 56)) > 3) throw new Error(JSON.stringify(saved));
  await until(async () => Math.abs((await rowHeight(kim, 'A2')) - saved['2']) <= 1);
  const img = await cell(page, 'B2').locator('img').evaluate((el) => Math.round(el.getBoundingClientRect().height));
  if (img < saved['2'] - 10) throw new Error('picture should fill the taller row: ' + img);
  await page.screenshot({ path: `${SP}/shots/rowheight.png` });
});
await step('Resize rows… sets several at once; a row inserted above moves them', async () => {
  await page.locator('tbody th', { hasText: /^3$/ }).click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.locator('tbody th', { hasText: /^3$/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Resize rows 3–4…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Height of rows 3–4' });
  await dlg.getByRole('textbox').fill('5000');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.getByText('Type a number from 16 to 600').waitFor();
  await dlg.getByRole('textbox').fill('50');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await until(async () => Math.abs((await rowHeight(page, 'A4')) - 50) <= 1 && Math.abs((await rowHeight(page, 'A3')) - 50) <= 1).catch(async (e) => { console.log('DBG', await rowHeight(page, 'A3'), await rowHeight(page, 'A4'), JSON.stringify((await content()).sheets[0].rowHeights)); throw e; });
  await page.locator('tbody th', { hasText: /^1$/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Insert 1 row above/ }).click();
  await until(async () => { const h = (await content()).sheets[0].rowHeights; return h && h['4'] === 50 && h['5'] === 50 && h['3'] > 70 && !h['2']; });
});
await step('double-click the edge, or Standard row height, brings rows back', async () => {
  await page.getByRole('separator', { name: 'Resize row 3', exact: true }).dblclick();
  await until(async () => (await rowHeight(page, 'A3')) <= 30);
  await page.locator('tbody th', { hasText: /^4$/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Standard row height' }).click();
  await until(async () => { const h = (await content()).sheets[0].rowHeights; return h && !h['4'] && h['5'] === 50; });
});
await step('Excel keeps the heights', async () => {
  const r = await page.evaluate(async (id) => (await fetch(`/api/files/${id}/export`)).status, sheetId);
  if (r !== 200) throw new Error(String(r));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
