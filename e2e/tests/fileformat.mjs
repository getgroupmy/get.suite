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
const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
const fs = await import('node:fs');
const zipNames = async (dl) => Object.keys((await JSZip.loadAsync(fs.readFileSync(await dl.path()))).files).filter((n) => !n.endsWith('/')).sort();
await step('Settings: choose OpenDocument as the file format for downloads; it stays chosen', async () => {
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Minutes' });
  await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Costs' });
  await page.goto(`${B}/settings`);
  const sec = page.getByRole('region', { name: 'File format for downloads' }).or(page.locator('section', { has: page.getByRole('heading', { name: 'File format for downloads' }) }));
  await sec.getByRole('radio', { name: /Microsoft Office/ }).waitFor();
  if (!(await sec.getByRole('radio', { name: /Microsoft Office/ }).isChecked())) throw new Error('Office should be the start');
  await sec.getByRole('radio', { name: /OpenDocument/ }).check();
  await page.getByText('Files will download as OpenDocument').waitFor();
  await sec.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SP}/shots/fileformat.png` });
  await page.reload();
  await sec.getByRole('radio', { name: /OpenDocument/ }).waitFor();
  if (!(await sec.getByRole('radio', { name: /OpenDocument/ }).isChecked())) throw new Error('not kept');
});
await step('Download your data: documents as .odt, spreadsheets as .ods', async () => {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /Download your data/ }).click()]);
  const names = await zipNames(dl);
  if (!names.includes('Drive/Minutes.odt') || !names.includes('Drive/Costs.ods')) throw new Error(names.join(', '));
});
await step('Drive: several selected download in a .zip as OpenDocument', async () => {
  await page.goto(`${B}/drive`);
  await page.getByLabel('Select Minutes').check();
  await page.getByLabel('Select Costs').check();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('toolbar', { name: 'Selected files' }).getByRole('button', { name: 'Download' }).click()]);
  const names = await zipNames(dl);
  if (names.join(',') !== 'Costs.ods,Minutes.odt') throw new Error(names.join(', '));
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
