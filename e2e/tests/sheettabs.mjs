// Sheet tabs: Duplicate puts a copy right after a sheet, Move left / Move right reorder them, and Delete removes one;
// a colleague sees the new order at once, formulas naming a sheet still work, and comments stay on their sheet.
import { chromium } from 'playwright';
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
const tabs = (p) => p.locator('.sheet-tab > button:first-child').allInnerTexts();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const menu = async (name, item) => {
  await page.locator('.sheet-tab > button:first-child', { hasText: new RegExp(`^${name}$`) }).click();
  await page.getByRole('button', { name: `Options for ${name}` }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
};
const anchorSheet = async () => (await api(page, 'GET', `/comments/${sheet.id}`)).body.find((t) => /Check this/.test(t.body)).anchor;
let sheet, kim;
await step('setup: a spreadsheet with three sheets, a comment on Notes, shared with Kim', async () => {
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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Quarter', content: { sheets: [
    { name: 'Budget', cells: { A1: 'Rent', B1: '900' }, tabColor: '#e53935' },
    { name: 'Notes', cells: { A1: 'Hello' } },
    { name: 'Plan', cells: { A1: '=Budget!B1*2' } },
  ] } })).body;
  const c = await api(page, 'POST', `/comments/${sheet.id}`, { body: 'Check this', anchor: { sheet: 1, cell: 'A1' } });
  if (c.status >= 300) throw new Error(JSON.stringify(c));
  const dir = (await api(page, 'GET', '/users/directory')).body;
  await api(page, 'PUT', `/files/${sheet.id}/shares`, { shares: [{ user_id: dir.find((u) => u.username === 'kim@acme.com').id, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/sheets/${sheet.id}`);
  await page.goto(`${B}/sheets/${sheet.id}`);
  await until(async () => same(await tabs(page), ['Budget', 'Notes', 'Plan']));
});
await step('Duplicate: “Copy of Budget” right after it, with its cells and colour; the comment stays on Notes', async () => {
  await menu('Budget', 'Duplicate');
  await until(async () => same(await tabs(page), ['Budget', 'Copy of Budget', 'Notes', 'Plan']));
  await page.locator('[data-k="B1"]').getByText('900').waitFor();
  const s = (await until(async () => { const c = (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content; return c.sheets.length === 4 && c; })).sheets[1];
  if (s.name !== 'Copy of Budget' || s.cells.B1 !== '900' || s.tabColor !== '#e53935') throw new Error(JSON.stringify(s));
  await until(async () => (await anchorSheet()).sheet === 2);
  await until(async () => same(await tabs(kim), ['Budget', 'Copy of Budget', 'Notes', 'Plan']), 10000);
});
await step('Move left and Move right: the order changes for Kim too, and Plan still works out Budget!B1', async () => {
  await menu('Plan', 'Move left');
  await until(async () => same(await tabs(page), ['Budget', 'Copy of Budget', 'Plan', 'Notes']));
  await until(async () => (await anchorSheet()).sheet === 3);
  await menu('Budget', 'Move right');
  await until(async () => same(await tabs(page), ['Copy of Budget', 'Budget', 'Plan', 'Notes']));
  await until(async () => same(await tabs(kim), ['Copy of Budget', 'Budget', 'Plan', 'Notes']), 10000);
  await page.locator('.sheet-tab > button:first-child', { hasText: /^Plan$/ }).click();
  await page.locator('[data-k="A1"]').getByText('1800').waitFor();
  // The comment is still on Notes, shown there
  await page.locator('.sheet-tab > button:first-child', { hasText: /^Notes$/ }).click();
  await page.locator('[data-k="A1"]').getByText('Hello').waitFor();
  if ((await anchorSheet()).sheet !== 3) throw new Error('the comment lost its sheet');
  await page.screenshot({ path: `${SP}/shots/sheet-tabs.png` });
});
await step('Delete a sheet before Notes: Notes\' comment follows it; the first and last tabs offer no move off the end', async () => {
  await menu('Copy of Budget', 'Delete');
  await page.getByRole('dialog', { name: 'Delete sheet?' }).getByRole('button', { name: 'Delete' }).click();
  await until(async () => same(await tabs(page), ['Budget', 'Plan', 'Notes']));
  await until(async () => (await anchorSheet()).sheet === 2);
  await page.locator('.sheet-tab > button:first-child', { hasText: /^Budget$/ }).click();
  await page.getByRole('button', { name: 'Options for Budget' }).click();
  if (await page.getByRole('menuitem', { name: 'Move left', exact: true }).count()) throw new Error('Move left on the first tab');
  await page.keyboard.press('Escape');
  await page.locator('.sheet-tab > button:first-child', { hasText: /^Notes$/ }).click();
  await page.getByRole('button', { name: 'Options for Notes' }).click();
  if (await page.getByRole('menuitem', { name: 'Move right', exact: true }).count()) throw new Error('Move right on the last tab');
  await page.keyboard.press('Escape');
});
await step('Ctrl+Page Down / Up (and with Shift) go to the next or previous sheet from the grid', async () => {
  await page.locator('.sheet-tab > button:first-child', { hasText: /^Budget$/ }).click();
  await page.locator('[data-k="A1"]').click();
  await page.keyboard.press('Control+PageDown');
  await until(async () => (await page.locator('.sheet-tab.on > button:first-child').innerText()) === 'Plan');
  await page.keyboard.press('Control+Shift+PageDown');
  await until(async () => (await page.locator('.sheet-tab.on > button:first-child').innerText()) === 'Notes');
  await page.keyboard.press('Control+PageDown'); // the last: stays
  await page.waitForTimeout(300);
  if ((await page.locator('.sheet-tab.on > button:first-child').innerText()) !== 'Notes') throw new Error('went past the last sheet');
  await page.keyboard.press('Control+PageUp');
  await until(async () => (await page.locator('.sheet-tab.on > button:first-child').innerText()) === 'Plan');
});
await step('dragging a tab puts it in a new place, for Kim too, and Notes\' comment goes with it', async () => {
  const tab = (n) => page.locator('.sheet-tab', { has: page.locator('button', { hasText: new RegExp(`^${n}$`) }) });
  await tab('Notes').dragTo(tab('Budget'));
  await until(async () => same(await tabs(page), ['Notes', 'Budget', 'Plan']));
  await until(async () => (await page.locator('.sheet-tab.on > button:first-child').innerText()) === 'Notes');
  await until(async () => (await anchorSheet()).sheet === 0);
  await until(async () => same(await tabs(kim), ['Notes', 'Budget', 'Plan']), 10000);
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
