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

const td = (p, k) => p.locator(`[data-k="${k}"]`);
await step('right-click → Insert note; the cell gets a corner mark and the note shows; the other editor sees it live', async () => {
  await td(page, 'B4').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Insert note' }).click();
  await page.getByLabel('Note on B4').fill('Cat was ill that week');
  await page.keyboard.press('Control+Enter');
  await td(page, 'B4').locator('.cell-note').waitFor();
  await page.getByRole('note', { name: 'Note on B4' }).getByText('Cat was ill that week').waitFor();
  if ((await td(page, 'B4').getAttribute('title')) !== 'Note: Cat was ill that week') throw new Error('hover text');
  await td(kim, 'B4').locator('.cell-note').waitFor();
  if ((await td(kim, 'B4').getAttribute('title')) !== 'Note: Cat was ill that week') throw new Error('kim');
  await until(async () => (await content()).notes?.B4 === 'Cat was ill that week');
});
await step('Shift+F2 edits it; Esc leaves it as it was; the note moves with its row', async () => {
  await td(page, 'B4').click();
  await page.keyboard.press('Shift+F2');
  await page.getByLabel('Note on B4').fill('Changed my mind');
  await page.keyboard.press('Escape');
  if ((await content()).notes?.B4 !== 'Cat was ill that week') throw new Error('Esc changed it');
  await page.keyboard.press('Shift+F2');
  await page.getByLabel('Note on B4').fill('Cat was ill (week 3)');
  await page.keyboard.press('Control+Enter');
  await until(async () => (await content()).notes?.B4 === 'Cat was ill (week 3)');
  await page.getByRole('rowheader', { name: '2' }).or(page.locator('th', { hasText: /^2$/ })).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Insert 1 row above$/ }).click();
  await until(async () => { const n = (await content()).notes || {}; return n.B5 === 'Cat was ill (week 3)' && !n.B4; });
  await td(kim, 'B5').locator('.cell-note').waitFor();
});
await step('viewers see notes but get no menu; Delete note takes it off', async () => {
  if ((await td(vic, 'B5').getAttribute('title')) !== 'Note: Cat was ill (week 3)') throw new Error('viewer');
  await td(vic, 'B5').click();
  await vic.keyboard.press('Shift+F2');
  await vic.getByRole('note', { name: 'Note on B5' }).waitFor(); // shown when selected
  if (await vic.getByRole('textbox', { name: 'Note on B5' }).count()) throw new Error('viewer can edit');
  await td(page, 'B5').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete note' }).click();
  await until(async () => !(await content()).notes?.B5);
  await until(async () => !(await td(kim, 'B5').locator('.cell-note').count()));
});
await step('clicking away keeps a note; the Excel download still works', async () => {
  await td(page, 'A2').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Insert note' }).click();
  await page.getByLabel('Note on A2').fill('Team lead');
  await td(page, 'D9').click(); // clicking away keeps it
  await until(async () => (await content()).notes?.A2 === 'Team lead');
  const xml = await page.evaluate(async (id) => {
    const r = await fetch(`/api/files/${id}/export`);
    return r.status;
  }, sheetId);
  if (xml !== 200) throw new Error('export');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
