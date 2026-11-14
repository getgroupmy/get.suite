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
  await page.goto(`${B}/drive`);
});
await step('Upload folder: the folder arrives with its folders and files', async () => {
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('menuitem', { name: 'Upload folder' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByLabel('Folder to upload').setInputFiles(`${ROOT}/e2e/fixtures/Trip`);
  await row('Trip').waitFor();
  await until(async () => (await api(page, 'GET', '/files')).body.filter((f) => f.name === 'Trip').length === 1, 15000);
  const trip = (await api(page, 'GET', '/files')).body.find((f) => f.name === 'Trip');
  await until(async () => (await api(page, 'GET', `/files?parent=${trip.id}`)).body.map((f) => f.name).sort().join() === 'Notes,Photos,readme.txt', 15000);
  const photos = (await api(page, 'GET', `/files?parent=${trip.id}`)).body.find((f) => f.name === 'Photos');
  await until(async () => (await api(page, 'GET', `/files?parent=${photos.id}`)).body.map((f) => f.name).sort().join() === 'beach.txt,hills.txt', 15000);
  await page.screenshot({ path: `${SP}/shots/upload-folder.png` });
});
await step('the same folder again goes into the same folders (files get new names, folders aren’t doubled)', async () => {
  await page.getByLabel('Folder to upload').setInputFiles(`${ROOT}/e2e/fixtures/Trip`);
  const trip = (await api(page, 'GET', '/files')).body.filter((f) => f.name === 'Trip');
  if (trip.length !== 1) throw new Error('one Trip');
  await until(async () => (await api(page, 'GET', `/files?parent=${trip[0].id}`)).body.length === 4, 15000);
  const names = (await api(page, 'GET', `/files?parent=${trip[0].id}`)).body.map((f) => f.name).sort();
  if (names.filter((n) => n === 'Photos').length !== 1) throw new Error(names.join());
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
