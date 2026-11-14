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
const row = (n) => page.locator('.files tbody tr', { hasText: n }).first();
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
  await api(page, 'POST', '/files/folder', { name: 'Invoices' });
  const d = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Board pack' })).body;
  await api(page, 'PUT', `/files/${d.id}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  await page.goto(`${B}/drive`);
  await row('Board pack').waitFor();
});
await step('details: what, whose, who has it; a description found by search', async () => {
  await row('Board pack').getByRole('button', { name: 'Actions for Board pack' }).click();
  await page.getByRole('menuitem', { name: 'Details' }).click();
  const dlg = page.getByRole('dialog', { name: 'Details' });
  await dlg.getByText('Document').waitFor();
  await dlg.getByText('Kim Park (can view)', { exact: true }).waitFor();
  await dlg.getByLabel('Description').fill('Papers for the November meeting');
  await dlg.getByText('Type', { exact: true }).click(); // leave the box
  await page.locator('.toast', { hasText: 'Description saved' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/details.png` });
  await dlg.getByRole('button', { name: 'Close' }).first().click();
  await page.getByLabel('Search everything').fill('november meeting');
  await page.keyboard.press('Enter');
  await row('Board pack').waitFor();
});
await step('a folder colour shows on its icon', async () => {
  await page.goto(`${B}/drive`);
  await row('Invoices').getByRole('button', { name: 'Actions for Invoices' }).click();
  await page.getByRole('menuitem', { name: 'Details' }).click();
  await page.getByRole('dialog', { name: 'Details' }).getByRole('radio', { name: '#d93025' }).click();
  await until(async () => (await row('Invoices').locator('svg.ft').evaluate((el) => getComputedStyle(el).color)) === 'rgb(217, 48, 37)');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
