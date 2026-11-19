// A sheet's tab colour: chosen from the tab's menu, seen by a colleague as it changes, removed again, and kept in an
// Excel download and brought back from it.
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
const tab = (p, name) => p.locator('.sheet-tab', { has: p.locator('button', { hasText: new RegExp(`^${name}$`) }) });
const bar = (p, name) => tab(p, name).locator('button').first().evaluate((el) => getComputedStyle(el).boxShadow);
let sheet, kim;
await step('setup: a spreadsheet with two sheets, shared with Kim', async () => {
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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Quarter', content: { sheets: [{ name: 'Budget', cells: { A1: 'Rent' } }, { name: 'Notes', cells: { A1: 'Hello' } }] } })).body;
  const dir = (await api(page, 'GET', '/users/directory')).body;
  await api(page, 'PUT', `/files/${sheet.id}/shares`, { shares: [{ user_id: dir.find((u) => u.username === 'kim@acme.com').id, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/sheets/${sheet.id}`);
  await tab(kim, 'Budget').waitFor();
});
await step('the tab\'s menu → Tab colour… → Red: a red bar under the tab, for Kim too', async () => {
  await page.goto(`${B}/sheets/${sheet.id}`);
  await tab(page, 'Budget').waitFor();
  await page.getByRole('button', { name: 'Options for Budget' }).click();
  await page.getByRole('menuitem', { name: 'Tab colour…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Tab colour for “Budget”' });
  await dlg.getByRole('button', { name: 'Red' }).click();
  await dlg.waitFor({ state: 'detached' });
  await until(async () => (await bar(page, 'Budget')).includes('rgb(229, 57, 53)'));
  if ((await tab(page, 'Budget').locator('button').first().getAttribute('title')) !== 'Tab colour: Red') throw new Error('no name for it');
  if ((await bar(page, 'Notes')).includes('rgb(229, 57, 53)')) throw new Error('the other tab changed too');
  await until(async () => (await bar(kim, 'Budget')).includes('rgb(229, 57, 53)'), 10000);
  await page.screenshot({ path: `${SP}/shots/tab-colour.png` });
});
await step('kept in the Excel download, and back when it is opened', async () => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Download as Excel/ }).click()]);
  const fs = await import('node:fs');
  const bytes = fs.readFileSync(await dl.path());
  const JSZip = (await import('module')).createRequire(`${ROOT}/server/package.json`)('jszip');
  const xml = await (await JSZip.loadAsync(bytes)).file('xl/worksheets/sheet1.xml').async('string');
  if (!/<tabColor rgb="FFE53935"\/>/.test(xml)) throw new Error('no tab colour in the Excel file');
  const up = await page.evaluate(async (b64) => (await fetch('/api/files/upload?name=Quarter%20(Excel).xlsx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) })).json(), bytes.toString('base64'));
  const opened = (await api(page, 'POST', `/files/${up.id}/open-as`)).body;
  await page.goto(`${B}/sheets/${opened.id}`);
  await tab(page, 'Budget').waitFor();
  await until(async () => (await bar(page, 'Budget')).includes('rgb(229, 57, 53)'));
});
await step('No colour takes it away again', async () => {
  await page.goto(`${B}/sheets/${sheet.id}`);
  await tab(page, 'Budget').waitFor();
  await page.getByRole('button', { name: 'Options for Budget' }).click();
  await page.getByRole('menuitem', { name: 'Tab colour…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Tab colour for “Budget”' });
  if ((await dlg.getByRole('button', { name: 'Red' }).getAttribute('aria-pressed')) !== 'true') throw new Error('the chosen one isn\'t marked');
  await dlg.getByRole('button', { name: 'No colour' }).click();
  await until(async () => !(await bar(page, 'Budget')).includes('rgb(229, 57, 53)'));
  await until(async () => !(await bar(kim, 'Budget')).includes('rgb(229, 57, 53)'), 10000);
  await until(async () => !('tabColor' in (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content.sheets[0]));
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
