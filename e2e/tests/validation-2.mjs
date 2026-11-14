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
const text = (p, k) => cell(p, k).innerText();
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
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const dir = (await api(page, 'GET', '/users/directory')).body;
  const cells = { A1: 'Task', B1: 'Status', C1: 'Paid', A2: 'Logo', B2: 'Open', A3: 'Website', B3: 'Done', A4: 'Flyers', A5: 'Total paid', C5: '=COUNTIF(C2:C4, TRUE)' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Tracker', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await api(page, 'PUT', `/files/${sheetId}/shares`, { shares: [{ user_id: dir.find((u) => u.username === 'kim@acme.com').id, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/sheets/${sheetId}`); await cell(p, 'A3').getByText('Website').waitFor(); }
});
await step('make a dropdown from the values already in the cells, plus one more', async () => {
  await cell(page, 'B2').click();
  await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowDown');
  await page.getByRole('button', { name: 'Data validation' }).click();
  const dlg = page.getByRole('dialog', { name: 'Data validation' });
  if (await dlg.getByLabel('Cells').inputValue() !== 'B2:B4') throw new Error(await dlg.getByLabel('Cells').inputValue());
  const ch = dlg.getByLabel(/^Choices/);
  if ((await ch.inputValue()) !== 'Open\nDone') throw new Error(JSON.stringify(await ch.inputValue()));
  await ch.fill('Open\nIn progress\nDone');
  await dlg.getByRole('button', { name: 'Add' }).click();
  await dlg.getByText('Dropdown: Open, In progress, Done').waitFor();
  await page.keyboard.press('Escape');
  await cell(kim, 'B4').getByRole('button', { name: 'Choices for B4' }).waitFor();
});
await step('pick from the dropdown; the other person sees it', async () => {
  await cell(page, 'B4').getByRole('button', { name: 'Choices for B4' }).click();
  await page.getByRole('listbox', { name: 'Choices' }).getByRole('option', { name: 'In progress' }).click();
  await until(async () => (await text(kim, 'B4')).includes('In progress'));
});
await step('the keyboard: Alt+Down opens it, arrows and Enter pick', async () => {
  await cell(page, 'B2').click();
  await page.keyboard.press('Alt+ArrowDown');
  await page.getByRole('listbox', { name: 'Choices' }).waitFor();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await until(async () => (await text(page, 'B2')).includes('In progress'));
});
await step('typing: right spelling is fixed, other values are refused', async () => {
  await cell(page, 'B3').click();
  await page.keyboard.type('open'); await page.keyboard.press('Enter');
  await until(async () => (await text(page, 'B3')).includes('Open'));
  await cell(page, 'B3').click();
  await page.keyboard.type('Maybe'); await page.keyboard.press('Enter');
  await page.locator('.toast', { hasText: 'Choose one of: Open, In progress, Done' }).waitFor();
  await page.keyboard.press('Escape');
  if (!(await text(page, 'B3')).includes('Open')) throw new Error('kept the old value');
});
await step('tick boxes: click and Space toggle, and formulas count them', async () => {
  await cell(page, 'C2').click();
  await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowDown');
  await page.getByRole('button', { name: 'Data validation' }).click();
  const dlg = page.getByRole('dialog', { name: 'Data validation' });
  await dlg.getByRole('button', { name: 'Add' }).click();
  await dlg.getByRole('radio', { name: 'Tick box' }).click();
  await dlg.getByLabel('Cells').fill('C2:C4');
  await dlg.getByRole('button', { name: 'Add' }).click();
  await dlg.getByText('Tick box').first().waitFor();
  await page.keyboard.press('Escape');
  await page.getByLabel('Tick C2').click();
  await until(async () => (await text(page, 'C5')).trim() === '1');
  await cell(page, 'C3').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press(' ');
  await until(async () => (await text(kim, 'C5')).trim() === '2');
  if (!(await kim.getByLabel('Tick C3').isChecked())) throw new Error('Kim sees it ticked');
  await page.keyboard.press(' ');
  await until(async () => (await text(page, 'C5')).trim() === '1');
  await page.screenshot({ path: `${SP}/shots/validation.png` });
});
await step('a row inserted above moves them down; Excel keeps them', async () => {
  await cell(page, 'A1').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Insert 1 row above/ }).click();
  await cell(page, 'B5').getByRole('button', { name: 'Choices for B5' }).waitFor();
  await page.getByLabel('Tick C3').waitFor();
  const r = await page.evaluate(async (id) => { const res = await fetch(`/api/files/${id}/export`); return { status: res.status, size: (await res.arrayBuffer()).byteLength }; }, sheetId);
  if (r.status !== 200 || r.size < 1000) throw new Error(JSON.stringify(r));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
