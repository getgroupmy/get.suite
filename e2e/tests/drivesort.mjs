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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const rowNames = async () => (await page.locator('table.files tbody tr td.name .name-text').allInnerTexts()).map((t) => t.split('\n')[0].trim());
const tileNames = async () => (await page.locator('.file-grid .tile-name .ellipsis').allInnerTexts()).map((t) => t.trim());
const upload = (name, buf) => page.evaluate(async ([n, b64]) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const r = await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes });
  return r.json();
}, [name, buf.toString('base64')]);
await step('sort by clicking the headings: folders stay first; the choice is remembered', async () => {
  await api(page, 'POST', '/files/folder', { name: 'Zeta folder' });
  await upload('Report 10.txt', Buffer.alloc(10, 65));
  await new Promise((r) => setTimeout(r, 30));
  await upload('Report 2.txt', Buffer.alloc(3000, 65));
  await new Promise((r) => setTimeout(r, 30));
  await upload('photo.png', PNG);
  await page.goto(`${B}/drive`);
  await page.getByText('photo.png').waitFor();
  if ((await rowNames()).join('|') !== 'Zeta folder|photo.png|Report 2.txt|Report 10.txt') throw new Error(`name: ${(await rowNames()).join('|')}`);
  await page.getByRole('button', { name: 'Size' }).click();
  await until(async () => (await rowNames()).join('|') === 'Zeta folder|Report 2.txt|photo.png|Report 10.txt');
  await page.getByRole('columnheader', { name: /Size/ }).getAttribute('aria-sort').then((v) => { if (v !== 'descending') throw new Error(v); });
  await page.getByRole('button', { name: 'Size' }).click();
  await until(async () => (await rowNames()).join('|') === 'Zeta folder|Report 10.txt|photo.png|Report 2.txt');
  await page.getByRole('button', { name: 'Modified' }).click();
  await until(async () => (await rowNames())[1] === 'photo.png'); // newest first
  await until(async () => (await api(page, 'GET', '/auth/me')).body.user.drive_view.sort === 'modified');
  await page.reload();
  await page.getByText('photo.png').waitFor();
  if ((await rowNames())[1] !== 'photo.png') throw new Error('not remembered');
});
await step('grid: tiles with a picture of a picture; open a folder by double-click', async () => {
  await page.getByRole('button', { name: 'Grid' }).click();
  await page.locator('.file-grid').waitFor();
  await until(async () => (await tileNames()).join('|') === 'Zeta folder|photo.png|Report 2.txt|Report 10.txt');
  await page.locator('.file-tile', { hasText: 'photo.png' }).locator('img').evaluate((img) => new Promise((ok, no) => { if (img.complete && img.naturalWidth) ok(); else { img.onload = ok; img.onerror = () => no(new Error('no thumbnail')); } }));
  await page.getByLabel('Sort by').selectOption('name:asc');
  await until(async () => (await tileNames()).join('|') === 'Zeta folder|photo.png|Report 2.txt|Report 10.txt');
  await page.getByLabel('Select Report 2.txt').check();
  await page.getByRole('toolbar', { name: 'Selected files' }).getByText('1 selected').waitFor();
  await page.screenshot({ path: `${SP}/shots/drivegrid.png` });
  await page.locator('.file-grid').getByRole('button', { name: 'Zeta folder', exact: true }).dblclick();
  await page.getByRole('navigation', { name: 'Folder path' }).getByText('Zeta folder').waitFor();
  await page.locator('.file-grid, .empty, [class*=empty]').first().waitFor();
  if ((await api(page, 'GET', '/auth/me')).body.user.drive_view.layout !== 'grid') throw new Error('grid not kept');
});
await step('folders show their size and how many files; sorting by size counts them', async () => {
  const big = (await api(page, 'POST', '/files/folder', { name: 'Big folder' })).body;
  await page.evaluate(async (id) => fetch(`/api/files/upload?parent=${id}&name=big.bin`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: new Uint8Array(50000) }), big.id);
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'List' }).click();
  const rowOf = (n) => page.locator('table.files tbody tr', { hasText: n });
  await rowOf('Big folder').getByText('48.8 KB').or(rowOf('Big folder').getByText('50 KB')).or(rowOf('Big folder').getByText('49 KB')).first().waitFor();
  if (await rowOf('Big folder').getByTitle('1 file inside').count() !== 1) throw new Error('file count');
  await rowOf('Zeta folder').getByText('Empty').waitFor();
  await page.getByRole('button', { name: 'Size' }).click();
  await until(async () => { const n = await rowNames(); return n[0] === 'Big folder' && n[1] === 'Zeta folder'; });
});
await step('back to the list', async () => {
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'List' }).click();
  await page.locator('table.files').waitFor();
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
