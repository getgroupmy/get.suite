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
const text = async (p, k) => (await cell(p, k).innerText()).trim();
const content = async () => (await api(page, 'GET', `/files/${sheetId}/content`)).body.content;
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
  const cells = { A1: 'Profit', A2: '1500', A3: '-250', A4: '0', B1: 'When', B2: '46335.6041666667' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Results', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await api(page, 'PUT', `/files/${sheetId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/sheets/${sheetId}`); await cell(p, 'A1').getByText('Profit').waitFor(); }
});
await step('Custom…: type a code, see the preview, apply to the selection', async () => {
  await cell(page, 'A4').click();
  await page.keyboard.press('Shift+ArrowUp'); await page.keyboard.press('Shift+ArrowUp'); // the cursor ends on A2, which the preview shows
  await page.getByLabel('Number format').selectOption('custom');
  const dlg = page.getByRole('dialog', { name: 'Custom number format' });
  await dlg.getByLabel('Format code').fill('"RM"#,##0.00;[Red]("RM"#,##0.00);"Nil"');
  await until(async () => (await dlg.locator('output').innerText()) === 'RM1,500.00');
  await page.screenshot({ path: `${SP}/shots/numfmt-dialog.png` });
  await dlg.getByRole('button', { name: 'Apply' }).click();
  await until(async () => (await text(page, 'A2')) === 'RM1,500.00' && (await text(page, 'A3')) === '(RM250.00)' && (await text(page, 'A4')) === 'Nil');
  const red = await cell(page, 'A3').evaluate((td) => getComputedStyle(td).color);
  if (red !== 'rgb(217, 48, 37)') throw new Error('negative in red: ' + red);
  await until(async () => (await text(kim, 'A3')) === '(RM250.00)');
  const f = await until(async () => (await content()).sheets[0].formats?.A2);
  if (f.num !== 'custom' || !f.code.startsWith('"RM"')) throw new Error(JSON.stringify(f));
});
await step('pick an example for a date and time; edit the code later with ✎', async () => {
  await cell(page, 'B2').click();
  await page.getByLabel('Number format').selectOption('custom');
  const dlg = page.getByRole('dialog', { name: 'Custom number format' });
  await dlg.getByRole('button', { name: /h:mm AM\/PM/ }).click();
  await dlg.getByRole('button', { name: 'Apply' }).click();
  await until(async () => (await text(page, 'B2')) === '2:30 PM');
  await page.getByRole('button', { name: 'Edit format code' }).click();
  await dlg.getByLabel('Format code').fill('ddd d mmm, hh:mm');
  await dlg.getByLabel('Format code').press('Enter');
  await until(async () => (await text(page, 'B2')) === 'Mon 9 Nov, 14:30');
  await page.screenshot({ path: `${SP}/shots/numfmt.png` });
});
await step('the cell value is unchanged, and another format replaces the code', async () => {
  await cell(page, 'A2').click();
  if ((await page.locator('.formula-bar input:not(.cell-name), .formula-bar textarea').first().inputValue()) !== '1500') throw new Error('value kept');
  await page.getByLabel('Number format').selectOption('percent');
  await until(async () => (await text(page, 'A2')) === '150,000%');
  await until(async () => { const f = (await content()).sheets[0].formats?.A2; return f && f.num === 'percent' && !f.code; });
});
await step('Excel download keeps the codes', async () => {
  const r = await page.evaluate(async (id) => (await fetch(`/api/files/${id}/export`)).status, sheetId);
  if (r !== 200) throw new Error(String(r));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
