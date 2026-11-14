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
const cell = (p, k) => p.locator(`[data-k="${k}"]`).textContent();
const raw = async (p, k) => { await p.locator(`[data-k="${k}"]`).click(); return p.getByLabel('Cell contents').inputValue(); };

await step('setup: a table with a total, a chart and a comment, shared with an editor and a viewer', async () => {
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
  const cells = { A1: 'Name', B1: 'Score', C1: 'Double', A2: 'bob', B2: '7', A3: 'Amy', B3: '10', A4: 'cat', B4: '3', A5: 'dan', B5: '12', A7: 'Total', B7: '=SUM(B2:B5)' };
  for (let r = 2; r <= 5; r++) cells[`C${r}`] = `=B${r}*2`;
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Scores', content: { sheets: [{ name: 'Sheet1', cells, colWidths: { C: 140 }, charts: { ch1: { type: 'column', range: 'A1:B5', title: 'Scores', x: 500, y: 40, w: 360, h: 240 } } }] } })).body.id;
  await api(page, 'PUT', `/files/${sheetId}/shares`, { shares: [{ user_id: idOf('kim@acme.com'), role: 'editor' }, { user_id: idOf('vic@acme.com'), role: 'viewer' }] });
  await api(page, 'POST', `/comments/${sheetId}`, { body: 'Check cat', anchor: { sheet: 0, cell: 'C4' } });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  vic = await mk('vic'); await signIn(vic, 'vic@acme.com');
  for (const p of [page, kim, vic]) { await p.goto(`${B}/sheets/${sheetId}`); await p.locator('[data-k="B7"]', { hasText: '32' }).waitFor(); }
});

const td = (k) => page.locator(`[data-k="${k}"]`);
const copyRange = async (a, b) => { await td(a).click(); if (b) await td(b).click({ modifiers: ['Shift'] }); await page.keyboard.press('Control+c'); };
const menuPaste = async (at, label) => { await td(at).click(); await td(at).click({ button: 'right' }); await page.getByRole('menuitem', { name: `Paste special: ${label}` }).click(); };
await step('values only: formulas come as their results (from the menu, and with Ctrl+Shift+V)', async () => {
  await copyRange('C2', 'C3'); // =B2*2 and =B3*2: 14 and 20
  await menuPaste('I2', 'values only');
  await until(async () => { const c = (await content()).cells; return c.I2 === '14' && c.I3 === '20'; });
  if ((await raw(page, 'I2')) !== '14') throw new Error('a formula was pasted');
  await td('J2').click();
  await page.keyboard.press('Control+Shift+V');
  await until(async () => { const c = (await content()).cells; return c.J2 === '14' && c.J3 === '20'; });
  // A normal paste still brings the formula, moved.
  await td('K2').click();
  await page.keyboard.press('Control+v');
  await until(async () => (await content()).cells.K2 === '=J2*2');
});
await step('formatting only: the format without the value', async () => {
  await td('A1').click();
  await page.keyboard.press('Control+b');
  await until(async () => (await content()).formats?.A1?.b);
  await copyRange('A1');
  await menuPaste('B9', 'formatting only');
  await until(async () => { const s = await content(); return s.formats?.B9?.b && !s.cells.B9; });
});
await step('transposed: rows become columns', async () => {
  await copyRange('A2', 'B3'); // bob 7 / Amy 10
  await menuPaste('A10', 'transposed');
  await until(async () => { const c = (await content()).cells; return c.A10 === 'bob' && c.B10 === 'Amy' && c.A11 === '7' && c.B11 === '10'; });
  await td('B11').waitFor();
  if ((await td('B11').innerText()) !== '10') throw new Error(await td('B11').innerText());
  await td(kim ? 'B11' : 'B11').waitFor();
  await kim.locator('[data-k="B10"]', { hasText: 'Amy' }).waitFor(); // the other editor sees it
});
await step('viewers get no paste', async () => {
  await vic.locator('[data-k="A2"]').click({ button: 'right' });
  await vic.waitForTimeout(300);
  if (await vic.getByRole('menuitem', { name: /Paste special/ }).count()) throw new Error('viewer menu');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
