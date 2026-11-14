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
const box = (p, label) => p.locator(`.slide-stage [aria-label^="${label}"]`).first();
const cell = (p, k) => p.locator(`[data-k="${k}"]`).textContent();
const type = async (p, k, v) => { await p.locator(`[data-k="${k}"]`).click(); await p.keyboard.type(v); await p.keyboard.press('Enter'); };
const pause = (ms = 700) => new Promise((r) => setTimeout(r, ms)); // separate undo steps
let sheetId, deckId, kim;

await step('setup: a spreadsheet and a presentation shared with an editor', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const dir = (await api(page, 'GET', '/users/directory')).body;
  const kimId = dir.find((u) => u.username === 'kim@acme.com').id;
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Numbers' })).body.id;
  deckId = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Pitch' })).body.id;
  for (const id of [sheetId, deckId]) await api(page, 'PUT', `/files/${id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/sheets/${sheetId}`); await p.locator('[data-k="A1"]').waitFor(); }
});

await step('Sheets: undo takes back only your own changes; redo puts them back', async () => {
  if (await page.getByRole('button', { name: 'Undo' }).isEnabled()) throw new Error('undo before any change');
  await type(page, 'A1', 'one'); await pause();
  await type(kim, 'B1', 'kim'); await pause();
  await type(page, 'A2', 'two'); await pause();
  await page.keyboard.press('Control+z');
  await until(async () => (await cell(kim, 'A2')) === '' && (await cell(kim, 'A1')) === 'one');
  await page.getByRole('button', { name: 'Undo' }).click();
  await until(async () => (await cell(kim, 'A1')) === '');
  if (await cell(page, 'B1') !== 'kim') throw new Error("Kim's change was undone");
  if (await page.getByRole('button', { name: 'Undo' }).isEnabled()) throw new Error('nothing left to undo');
  await page.keyboard.press('Control+y');
  await until(async () => (await cell(kim, 'A1')) === 'one');
  await page.keyboard.press('Control+Shift+z');
  await until(async () => (await cell(kim, 'A2')) === 'two');
});

await step('Sheets: undo a format, an inserted row and a sort', async () => {
  await page.locator('[data-k="A1"]').click();
  await page.keyboard.press('Control+b'); await pause();
  if (!(await page.locator('[data-k="A1"]').getAttribute('style'))?.match(/font-weight: (bold|700)/)) throw new Error('not bold');
  await page.keyboard.press('Control+z');
  await until(async () => !(await page.locator('[data-k="A1"]').getAttribute('style') || '').match(/font-weight: (bold|700)/));
  await page.locator('tbody th', { hasText: /^1$/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Insert 1 row above' }).click();
  await until(async () => (await cell(kim, 'A2')) === 'one');
  await pause();
  await page.keyboard.press('Control+z');
  await until(async () => (await cell(kim, 'A1')) === 'one' && (await cell(kim, 'B1')) === 'kim');
  await page.locator('[data-k="A1"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Sort Z → A by column A' }).click();
  await until(async () => (await cell(page, 'A1')) === 'two');
  await pause();
  await page.keyboard.press('Control+z');
  await until(async () => (await cell(kim, 'A1')) === 'one' && (await cell(kim, 'A2')) === 'two');
});

await step('Sheets: while typing in a cell, Ctrl+Z is the text box\'s own', async () => {
  await page.locator('[data-k="C1"]').click();
  await page.keyboard.type('abc');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Escape');
  if (await cell(page, 'A1') !== 'one') throw new Error('a sheet change was undone while typing');
});

await step('Slides: undo a new box and its text, keeping a colleague\'s', async () => {
  for (const p of [page, kim]) { await p.goto(`${B}/slides/${deckId}`); await p.getByText('Click to add title').waitFor(); }
  await kim.getByText('Click to add title').dblclick();
  await kim.keyboard.type('Kim title');
  await kim.locator('.slide-stage').click({ position: { x: 5, y: 5 } });
  await until(async () => (await box(page, 'Text: Kim title').count()) > 0);
  await pause();
  await page.getByRole('button', { name: 'Text box' }).click();
  await page.keyboard.type('Mine');
  await page.locator('.slide-stage').click({ position: { x: 5, y: 5 } });
  await until(async () => (await box(kim, 'Text: Mine').count()) > 0);
  await pause();
  for (let i = 0; i < 3 && (await box(kim, 'Text: Mine').count()); i++) { await page.keyboard.press('Control+z'); await pause(300); }
  await until(async () => (await box(kim, 'Text: Mine').count()) === 0);
  if (!(await box(page, 'Text: Kim title').count())) throw new Error("Kim's title went");
  for (let i = 0; i < 3 && !(await box(kim, 'Text: Mine').count()); i++) { await page.getByRole('button', { name: 'Redo' }).click(); await pause(300); }
  await until(async () => (await box(kim, 'Text: Mine').count()) > 0);
  await page.screenshot({ path: `${SP}/shots/undo-slides.png` });
});

await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
