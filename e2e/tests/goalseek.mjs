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
const stored = async () => (await api(page, 'GET', `/files/${sheetId}/content`)).body.content.sheets[0].cells;
const open = async (p) => {
  await p.getByRole('button', { name: 'More', exact: true }).click();
  await p.getByRole('menuitem', { name: 'Goal seek…' }).click();
  return p.getByRole('dialog', { name: 'Goal seek' });
};
await step('setup: a profit sheet shared with an editor and a viewer', async () => {
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
  const cells = { A1: 'Units', B1: '500', A2: 'Price', B2: '12', A3: 'Costs', B3: '4000', A4: 'Profit', B4: '=B1*B2-B3', A5: 'Label', B5: 'n/a' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Profit', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await api(page, 'PUT', `/files/${sheetId}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell(page, 'B4').getByText('2000').waitFor();
});
await step('Goal seek from the formula cell: solve, then keep it', async () => {
  await cell(page, 'B4').click();
  const dlg = await open(page);
  if ((await dlg.getByLabel('Set cell').inputValue()) !== 'B4') throw new Error('set cell not filled from the selection');
  await dlg.getByLabel('To value').fill('10000');
  await dlg.getByLabel('By changing').fill('b2');
  await dlg.getByRole('button', { name: 'Solve' }).click();
  await dlg.getByRole('status').getByText('B2 = 28 makes B4 come to 10000.').waitFor();
  if ((await stored()).B2 !== '12') throw new Error('changed before keeping');
  await dlg.getByRole('button', { name: 'Keep it' }).click();
  await page.locator('.toast', { hasText: 'B2 set to 28' }).last().waitFor();
  await cell(page, 'B4').getByText('10000').waitFor();
  await until(async () => (await stored()).B2 === '28');
});
await step('Undo puts the old number back', async () => {
  await page.keyboard.press('Control+z');
  await cell(page, 'B4').getByText('2000').waitFor();
  await until(async () => (await stored()).B2 === '12');
});
await step('What it refuses, said plainly', async () => {
  await cell(page, 'A1').click();
  const dlg = await open(page);
  if ((await dlg.getByLabel('Set cell').inputValue()) !== '') throw new Error('a cell without a formula is not offered');
  await dlg.getByLabel('Set cell').fill('B1');
  await dlg.getByLabel('To value').fill('5');
  await dlg.getByLabel('By changing').fill('B2');
  await dlg.getByRole('button', { name: 'Solve' }).click();
  await dlg.getByRole('alert').getByText('B1 needs a formula, worked out from B2').waitFor();
  await dlg.getByLabel('Set cell').fill('B4');
  await dlg.getByLabel('By changing').fill('B5');
  await dlg.getByLabel('By changing').press('Enter');
  await dlg.getByRole('alert').getByText('B5 needs a number in it (or nothing)').waitFor();
  await dlg.getByLabel('By changing').fill('C9');
  await dlg.getByRole('button', { name: 'Solve' }).click();
  await dlg.getByRole('alert').getByText("Changing C9 doesn't change B4").waitFor();
  await dlg.getByRole('button', { name: 'Cancel' }).click();
});
await step('Viewers do not get it', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/sheets/${sheetId}`);
  await cell(kim, 'B4').getByText('2000').waitFor();
  await kim.getByRole('button', { name: 'More', exact: true }).click();
  await kim.getByRole('menuitem', { name: 'Version history' }).waitFor();
  if (await kim.getByRole('menuitem', { name: 'Goal seek…' }).count()) throw new Error('viewer sees goal seek');
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
