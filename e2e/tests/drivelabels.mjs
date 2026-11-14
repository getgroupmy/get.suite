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
let kim;
const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
await step('label files from their menu: chips on them, and the label on the left lists them', async () => {
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'March invoice' });
  await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Tax sums' });
  await page.goto(`${B}/drive`);
  const row = (n) => page.locator('tr', { hasText: n });
  await row('March invoice').waitFor();
  const label = async (n, newLabel, tick) => {
    await row(n).getByRole('button', { name: /More actions|Actions for/ }).first().click();
    await page.getByRole('menuitem', { name: 'Labels…' }).click();
    const dlg = page.getByRole('dialog', { name: `Labels: ${n}` });
    if (newLabel) { await dlg.getByLabel('New label').fill(newLabel); await dlg.getByRole('button', { name: 'Add' }).click(); }
    if (tick) await dlg.getByRole('checkbox', { name: tick }).check();
    await dlg.getByRole('button', { name: 'Save' }).click();
    await dlg.waitFor({ state: 'detached' });
  };
  await label('March invoice', 'Taxes 2026');
  await row('March invoice').locator('.file-label', { hasText: 'Taxes 2026' }).waitFor();
  await label('Tax sums', null, 'Taxes 2026');
  const nav = page.getByRole('link', { name: 'Label Taxes 2026, 2' });
  await nav.waitFor();
  await nav.click();
  await page.getByRole('heading', { name: '🏷 Taxes 2026' }).waitFor();
  await row('Tax sums').waitFor();
  await row('March invoice').waitFor();
  await page.screenshot({ path: `${SP}/shots/drive-labels.png` });
});
await step('search narrowed to a label', async () => {
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Tax notes (no label)' });
  await page.goto(`${B}/drive/search?q=tax`);
  await page.locator('tr', { hasText: 'Tax notes (no label)' }).waitFor();
  await page.getByRole('group', { name: 'Filters' }).getByLabel('Label').selectOption('Taxes 2026');
  await until(async () => !(await page.locator('tr', { hasText: 'Tax notes (no label)' }).count()));
  await page.locator('tr', { hasText: 'Tax sums' }).waitFor();
  if (!/label=Taxes/.test(page.url())) throw new Error(page.url());
  await page.goto(`${B}/drive/label/${encodeURIComponent('Taxes 2026')}`);
});
await step('colour a label: a dot on the left, the chips take it', async () => {
  const lrow = page.locator('.drive-label-row', { hasText: 'Taxes 2026' });
  await lrow.hover();
  await lrow.getByRole('button', { name: 'Edit label Taxes 2026' }).click();
  await page.getByRole('menuitem', { name: 'Green' }).click();
  await lrow.locator('.drive-label-dot').waitFor();
  const chip = page.locator('tr', { hasText: 'Tax sums' }).locator('.file-label', { hasText: 'Taxes 2026' });
  await until(async () => (await chip.getAttribute('class')).includes('coloured'));
  if (!(await chip.getAttribute('style')).includes('#188038')) throw new Error(await chip.getAttribute('style'));
  await page.screenshot({ path: `${SP}/shots/drive-label-colour.png` });
});
await step('rename the label (the page follows), then delete it', async () => {
  const lrow = page.locator('.drive-label-row', { hasText: 'Taxes 2026' });
  await lrow.hover();
  await lrow.getByRole('button', { name: 'Edit label Taxes 2026' }).click();
  await page.getByRole('menuitem', { name: 'Rename label…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Rename label' });
  await dlg.getByLabel('Label name').fill('Taxes');
  await dlg.getByRole('button', { name: 'Rename' }).click();
  await page.getByRole('heading', { name: '🏷 Taxes' }).waitFor();
  await page.getByRole('link', { name: 'Label Taxes, 2' }).waitFor();
  await page.locator('tr', { hasText: 'Tax sums' }).locator('.file-label', { hasText: /^Taxes$/ }).waitFor();
  const r2 = page.locator('.drive-label-row', { hasText: 'Taxes' });
  await r2.hover();
  await r2.getByRole('button', { name: 'Edit label Taxes' }).click();
  await page.getByRole('menuitem', { name: 'Delete label' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete label' }).click();
  await page.waitForURL(/\/drive$/);
  await until(async () => !(await page.locator('.drive-label-row').count()));
  if (await page.locator('.file-label').count()) throw new Error('labels left on files');
});
await step('label several files at once from the selection bar', async () => {
  await page.goto(`${B}/drive`);
  for (const n of ['March invoice', 'Tax sums']) await page.locator('tr', { hasText: n }).getByRole('checkbox').check();
  await page.getByRole('toolbar', { name: 'Selected files' }).getByRole('button', { name: /Label…/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Label 2 items' });
  await dlg.getByLabel('Label', { exact: true }).fill('Q1');
  await dlg.getByRole('button', { name: 'Add label' }).click();
  await page.getByRole('link', { name: 'Label Q1, 2' }).waitFor();
  await page.locator('tr', { hasText: 'Tax sums' }).locator('.file-label', { hasText: /^Q1$/ }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
