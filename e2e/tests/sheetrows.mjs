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

await step('insert a row above row 3 from the row heading: everything below moves down, formulas follow', async () => {
  await page.locator('tbody th', { hasText: /^3$/ }).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Row actions' }).getByRole('menuitem', { name: 'Insert 1 row above' }).click();
  await kim.locator('[data-k="A4"]', { hasText: 'Amy' }).waitFor();
  if (await cell(kim, 'A3') !== '') throw new Error('row 3 not empty');
  if (await raw(page, 'B8') !== '=SUM(B2:B6)') throw new Error('total formula');
  if (await raw(page, 'C4') !== '=B4*2') throw new Error('row formula');
  await page.locator('[data-k="C5"] .cell-comment').waitFor(); // the comment moved with its cell
  await until(async () => (await content()).charts.ch1.range === 'A1:B6');
  if ((await content()).colWidths.C !== 140) throw new Error('width');
});

await step('select two rows with the headings and delete them', async () => {
  await page.locator('tbody th', { hasText: /^3$/ }).click();
  await page.locator('tbody th', { hasText: /^4$/ }).click({ modifiers: ['Shift'] });
  await page.locator('tbody th', { hasText: /^4$/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete rows 3–4' }).click();
  await kim.locator('[data-k="A3"]', { hasText: 'cat' }).waitFor();
  if (await raw(page, 'B6') !== '=SUM(B2:B4)') throw new Error('total after delete: ' + await raw(page, 'B6'));
  await page.locator('[data-k="B6"]', { hasText: '22' }).waitFor();
  await page.locator('[data-k="C3"] .cell-comment').waitFor();
});

await step('delete a column: formulas that used it say #REF!', async () => {
  await page.locator('thead th', { hasText: /^B$/ }).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Column actions' }).getByRole('menuitem', { name: 'Delete column B' }).click();
  await kim.locator('[data-k="B1"]', { hasText: 'Double' }).waitFor();
  await kim.locator('[data-k="B2"]', { hasText: '#REF!' }).waitFor();
  await until(async () => (await content()).colWidths.B === 140); // the width moved with column C
  await page.locator('[data-k="B3"] .cell-comment').waitFor();
  // Put the scores back in a new column B, for sorting.
  await page.locator('thead th', { hasText: /^B$/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Insert 1 column left' }).click();
  for (const [k, v] of [['B1', 'Score'], ['B2', '7'], ['B3', '3'], ['B4', '12']]) { await page.locator(`[data-k="${k}"]`).click(); await page.keyboard.type(v); await page.keyboard.press('Enter'); }
  await kim.locator('[data-k="B4"]', { hasText: '12' }).waitFor();
});

await step('sort Z → A by a column from the right-click menu; the heading row stays', async () => {
  await page.locator('[data-k="B3"]').click({ button: 'right' });
  await page.getByRole('menu', { name: 'Cell actions' }).getByRole('menuitem', { name: 'Sort Z → A by column B' }).click();
  await page.getByText('Sorted rows 2–4 by column B').waitFor();
  const names = async (p) => [await cell(p, 'A1'), await cell(p, 'A2'), await cell(p, 'A3'), await cell(p, 'A4')];
  await until(async () => (await names(kim)).join() === 'Name,dan,bob,cat');
  if (await cell(page, 'A6') !== 'Total') throw new Error('the total row was sorted in');
});

await step('the Sort dialog: by name, A → Z', async () => {
  await page.locator('[data-k="A2"]').click();
  await page.getByRole('button', { name: 'Sort range' }).click();
  const dlg = page.getByRole('dialog', { name: 'Sort range' });
  if (await dlg.getByLabel('Cells').inputValue() !== 'A1:C4') throw new Error('range ' + await dlg.getByLabel('Cells').inputValue());
  if (!(await dlg.getByLabel('The first row is headings').isChecked())) throw new Error('header not guessed');
  await dlg.getByLabel('Sort by').selectOption({ label: 'A (Name)' });
  await dlg.getByRole('button', { name: 'Sort', exact: true }).click();
  await until(async () => [await cell(kim, 'A2'), await cell(kim, 'A3'), await cell(kim, 'A4')].join() === 'bob,cat,dan');
  if (await cell(kim, 'B2') !== '7') throw new Error('scores did not move with names');
});

await step('the menu works from the keyboard', async () => {
  await page.locator('[data-k="A2"]').click();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu', { name: 'Cell actions' });
  await menu.waitFor();
  if (!(await menu.getByRole('menuitem', { name: 'Insert 1 row above' }).evaluate((el) => el === document.activeElement))) throw new Error('focus');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  await page.screenshot({ path: `${SP}/shots/sheetrows.png` });
});

await step('viewers get no such menu', async () => {
  await vic.locator('tbody th', { hasText: /^3$/ }).click({ button: 'right' });
  await new Promise((r) => setTimeout(r, 300));
  if (await vic.getByRole('menu', { name: 'Row actions' }).count()) throw new Error('viewer menu');
  if (await vic.getByRole('button', { name: 'Sort range' }).count()) throw new Error('viewer sort');
});

await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
