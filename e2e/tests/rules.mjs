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
const bg = (p, k) => p.locator(`[data-k="${k}"]`).evaluate((el) => getComputedStyle(el).backgroundColor);
const RED = 'rgb(252, 232, 230)', GREEN = 'rgb(230, 244, 234)';
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
  const cells = { A1: 'Item', B1: 'Cost', A2: 'Paper', B2: '40', A3: 'Desk', B3: '250', A4: 'Chair', B4: '120', A5: 'Pens' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Costs', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await api(page, 'PUT', `/files/${sheetId}/shares`, { shares: [{ user_id: dir.find((u) => u.username === 'kim@acme.com').id, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/sheets/${sheetId}`); await p.locator('[data-k="B3"]', { hasText: '250' }).waitFor(); }
});
await step('add a rule: costs over 100 turn red, for everyone', async () => {
  await page.locator('[data-k="B2"]').click();
  await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowDown');
  await page.getByRole('button', { name: 'Conditional formatting' }).click();
  const dlg = page.getByRole('dialog', { name: 'Conditional formatting' });
  if (await dlg.getByLabel('Apply to cells').inputValue() !== 'B2:B5') throw new Error('range ' + await dlg.getByLabel('Apply to cells').inputValue());
  await dlg.getByLabel('When the value is').selectOption('gt');
  await dlg.getByLabel('Value', { exact: true }).fill('100');
  await dlg.getByRole('button', { name: 'Red' }).click();
  await dlg.getByLabel('Bold').check();
  await dlg.getByRole('button', { name: 'Add rule' }).click();
  await dlg.getByText('B2:B5 · Greater than 100').waitFor();
  await page.keyboard.press('Escape');
  await until(async () => (await bg(kim, 'B3')) === RED && (await bg(kim, 'B4')) === RED && (await bg(kim, 'B2')) !== RED);
});
await step('the colour follows the value as it changes', async () => {
  await kim.locator('[data-k="B2"]').click(); await kim.keyboard.type('400'); await kim.keyboard.press('Enter');
  await until(async () => (await bg(page, 'B2')) === RED);
});
await step('a second rule; the first that fits wins; reorder and delete', async () => {
  await page.getByRole('button', { name: 'Conditional formatting' }).click();
  const dlg = page.getByRole('dialog', { name: 'Conditional formatting' });
  await dlg.getByRole('button', { name: 'Add a rule' }).click();
  await dlg.getByLabel('Apply to cells').fill('B2:B5');
  await dlg.getByLabel('When the value is').selectOption('gt');
  await dlg.getByLabel('Value', { exact: true }).fill('0');
  await dlg.getByRole('button', { name: 'Green' }).click();
  await dlg.getByRole('button', { name: 'Add rule' }).click();
  await until(async () => (await bg(page, 'B3')) === RED); // the red rule is tried first
  await dlg.getByRole('button', { name: 'Try earlier: B2:B5 · Greater than 0' }).click();
  await until(async () => (await bg(kim, 'B3')) === GREEN);
  await page.screenshot({ path: `${SP}/shots/rules.png` });
  await dlg.getByRole('button', { name: 'Delete rule B2:B5 · Greater than 0' }).click();
  await until(async () => (await bg(kim, 'B3')) === RED);
  await page.keyboard.press('Escape');
});
await step('inserting a row above keeps the rule on the same cells', async () => {
  await page.locator('tbody th', { hasText: /^2$/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Insert 1 row above' }).click();
  await until(async () => (await bg(kim, 'B4')) === RED && (await bg(kim, 'B2')) !== RED);
  await until(async () => (await api(page, 'GET', `/files/${sheetId}/content`)).body.content.sheets[0].rules?.[0]?.range === 'B3:B6');
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
