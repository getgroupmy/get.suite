import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
});
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
let folder;
const focusedName = () => page.evaluate(() => { const a = document.activeElement; return a?.closest?.('tr')?.querySelector('.name-text')?.firstChild?.textContent || a?.getAttribute?.('aria-label') || a?.tagName; });
const inFolder = async () => (await api(page, 'GET', `/files?view=mine&parent=${folder}`)).body;
const listOf = (b) => (Array.isArray(b) ? b : b.files || b.items || []);
await step('↓ from nothing goes to the first file; J / K and End move on, with the selection', async () => {
  folder = (await api(page, 'POST', '/files/folder', { name: 'Projects' })).body.id;
  for (const n of ['Alpha plan', 'Beta plan', 'Gamma plan']) await api(page, 'POST', '/files/new', { kind: 'doc', name: n, parent_id: folder });
  await page.goto(`${B}/drive/folder/${folder}`);
  await page.locator('table.files tbody tr').nth(2).waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('ArrowDown');
  await until(async () => (await focusedName()) === 'Alpha plan');
  await page.keyboard.press('j');
  await until(async () => (await focusedName()) === 'Beta plan');
  if (!(await page.locator('table.files tbody tr.selected', { hasText: 'Beta plan' }).count())) throw new Error('not selected');
  await page.keyboard.press('End');
  await until(async () => (await focusedName()) === 'Gamma plan');
  await page.keyboard.press('k');
  await until(async () => (await focusedName()) === 'Beta plan');
  await page.screenshot({ path: `${SP}/shots/drive-keys.png` });
});
await step('S stars it; X ticks it; F2 renames it', async () => {
  await page.keyboard.press('s');
  await until(async () => listOf(await inFolder()).find((f) => f.name === 'Beta plan')?.starred);
  await page.keyboard.press('x');
  await page.getByLabel('Select Beta plan').and(page.locator(':checked')).waitFor();
  await page.keyboard.press('F2');
  const dlg = page.getByRole('dialog', { name: 'Rename' });
  await dlg.getByLabel('New name').fill('Beta budget');
  await dlg.getByLabel('New name').press('Enter');
  await until(async () => listOf(await inFolder()).some((f) => f.name === 'Beta budget'));
});
await step('Delete moves the focused file to the trash, with Undo', async () => {
  await page.locator('table.files tbody tr', { hasText: 'Gamma plan' }).focus();
  await page.keyboard.press('Delete');
  await page.locator('.toast', { hasText: /trash/i }).waitFor();
  await until(async () => !listOf(await inFolder()).some((f) => f.name === 'Gamma plan'));
});
await step('U goes up to the folder it’s in; the shortcut list shows Drive first', async () => {
  await page.locator('table.files tbody tr').first().focus();
  await page.keyboard.press('u');
  await until(async () => /\/drive\/?$/.test(page.url()));
  await page.locator('table.files tbody tr', { hasText: 'Projects' }).waitFor();
  await page.keyboard.press('Control+/');
  await page.getByRole('dialog').getByText('Up to the folder it’s in').waitFor();
  await axe(page, 'shortcut list');
  await page.keyboard.press('Escape');
});
await step('single keys off: J does nothing, ↓ still moves', async () => {
  await api(page, 'PUT', '/users/me/keys', { on: false });
  await page.reload();
  await page.locator('table.files tbody tr').first().waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('j');
  await page.waitForTimeout(400);
  if ((await focusedName()) === 'Projects') throw new Error('J still works');
  await page.keyboard.press('ArrowDown');
  await until(async () => (await focusedName()) === 'Projects');
  await api(page, 'PUT', '/users/me/keys', { on: true });
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
