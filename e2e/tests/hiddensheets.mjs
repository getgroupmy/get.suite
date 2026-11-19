// Hidden sheets: Hide sheet takes a tab away (for everyone; formulas still read it), Hidden sheets (n) shows it again;
// someone who can only view sees no hidden tab and no way to show one; the last shown sheet can't be hidden.
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
let sheet, kim, vee;
await step('setup: Lookup, Report and Notes; Kim can edit, Vee can only view', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  for (const [local, name] of [['kim', 'Kim Park'], ['vee', 'Vee Viewer']]) await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Prices', content: { sheets: [
    { name: 'Lookup', cells: { A1: '5' } }, { name: 'Report', cells: { A1: '=Lookup!A1*2' } }, { name: 'Notes', cells: { A1: 'Hi' } },
  ] } })).body;
  const dir = (await api(page, 'GET', '/users/directory')).body;
  const idOf = (u) => dir.find((x) => x.username === u).id;
  await api(page, 'PUT', `/files/${sheet.id}/shares`, { shares: [{ user_id: idOf('kim@acme.com'), role: 'editor' }, { user_id: idOf('vee@acme.com'), role: 'viewer' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com'); await kim.goto(`${B}/sheets/${sheet.id}`);
  await page.goto(`${B}/sheets/${sheet.id}`);
  await until(async () => same(await tabs(page), ['Lookup', 'Report', 'Notes']));
  await until(async () => same(await tabs(kim), ['Lookup', 'Report', 'Notes']));
});
await step('Hide sheet: Lookup\'s tab goes, for Kim too, the next sheet opens, and Report still reads Lookup', async () => {
  await menu('Lookup', 'Hide sheet');
  await until(async () => same(await tabs(page), ['Report', 'Notes']));
  await page.locator('[data-k="A1"]').getByText('10').waitFor(); // Report, opened in its place
  await until(async () => same(await tabs(kim), ['Report', 'Notes']), 10000);
  await kim.locator('[data-k="A1"]').getByText('10').waitFor(); // Kim was on Lookup: moved to a shown sheet
  await page.getByRole('button', { name: 'Hidden sheets (1)' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/hidden-sheets.png` });
});
await step('Vee, who can only view, sees no hidden tab and no way to show it', async () => {
  vee = await mk('vee'); await signIn(vee, 'vee@acme.com');
  await vee.goto(`${B}/sheets/${sheet.id}`);
  await until(async () => same(await tabs(vee), ['Report', 'Notes']));
  await vee.locator('[data-k="A1"]').getByText('10').waitFor();
  if (await vee.getByRole('button', { name: /Hidden sheets/ }).count()) throw new Error('a viewer can show hidden sheets');
});
await step('the last shown sheet can\'t be hidden', async () => {
  await menu('Notes', 'Hide sheet');
  await until(async () => same(await tabs(page), ['Report']));
  await page.getByRole('button', { name: 'Options for Report' }).click();
  if (await page.getByRole('menuitem', { name: 'Hide sheet', exact: true }).count()) throw new Error('could hide them all');
  await page.keyboard.press('Escape');
});
await step('Hidden sheets (2) → Show “Lookup”: its tab is back where it was, and it opens', async () => {
  await page.getByRole('button', { name: 'Hidden sheets (2)' }).click();
  await page.getByRole('menuitem', { name: 'Show “Lookup”' }).click();
  await until(async () => same(await tabs(page), ['Lookup', 'Report']));
  await page.locator('[data-k="A1"]').getByText('5').waitFor();
  await until(async () => same(await tabs(kim), ['Lookup', 'Report']), 10000);
  const c = (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content;
  if (JSON.stringify(c.sheets.map((s) => !!s.hidden)) !== JSON.stringify([false, false, true])) throw new Error(JSON.stringify(c.sheets.map((s) => s.hidden)));
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
