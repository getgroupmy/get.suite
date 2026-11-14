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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const pick = async (p, button) => { const [fc] = await Promise.all([p.waitForEvent('filechooser'), button.click()]); await fc.setFiles({ name: 'sales-chart.png', mimeType: 'image/png', buffer: PNG }); };
const DESC = 'Bar chart: sales doubled from 2025 to 2026';
await step('Docs: a picture is described in Alt text; screen readers get it and Word keeps it', async () => {
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Report' })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').click();
  await pick(page, page.getByRole('button', { name: 'Insert picture' }));
  const img = page.locator('.ProseMirror img');
  await img.waitFor();
  if ((await img.getAttribute('alt')) !== 'sales-chart') throw new Error('default ' + await img.getAttribute('alt'));
  await img.click();
  await page.getByRole('button', { name: 'Alt text' }).click();
  const dlg = page.getByRole('dialog', { name: 'Alt text' });
  await dlg.getByLabel('Description').fill(DESC);
  await dlg.screenshot({ path: `${SP}/shots/alttext-dialog.png` });
  await dlg.getByRole('button', { name: 'Save' }).click();
  await until(async () => (await img.getAttribute('alt')) === DESC);
  await page.waitForTimeout(2500);
  const r = await page.evaluate(async (id) => { const res = await fetch(`/api/files/${id}/export`); return { status: res.status, bytes: [...new Uint8Array(await res.arrayBuffer())] }; }, doc.id);
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const xml = await (await JSZip.loadAsync(Buffer.from(r.bytes))).file('word/document.xml').async('string');
  if (!xml.includes(`descr="${DESC}"`)) throw new Error('not in Word: ' + (xml.match(/descr="[^"]*"/) || ['none'])[0]);
});
await step('Slides: Alt text on a picture, read out, marked in the toolbar, and in PowerPoint', async () => {
  const deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Results' })).body;
  await page.goto(`${B}/slides/${deck.id}`);
  await pick(page, page.getByRole('button', { name: 'Picture', exact: true }));
  const img = page.locator('.slide-canvas img, .slide img').first();
  await img.waitFor();
  await page.getByRole('button', { name: 'Alt text' }).click();
  const dlg = page.getByRole('dialog', { name: 'Alt text' });
  await dlg.getByLabel('Description').fill(DESC);
  await dlg.getByLabel('Description').press('Enter');
  await dlg.waitFor({ state: 'detached' });
  await until(async () => (await img.getAttribute('alt')) === DESC);
  if (!(await page.getByRole('button', { name: 'Alt text' }).innerText()).includes('✓')) throw new Error('not marked');
  await page.locator(`.slide-item[aria-label="Picture: ${DESC}"]`).first().waitFor();
  await page.waitForTimeout(2500);
  const r = await page.evaluate(async (id) => { const res = await fetch(`/api/files/${id}/export`); return { status: res.status, bytes: [...new Uint8Array(await res.arrayBuffer())] }; }, deck.id);
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const zip = await JSZip.loadAsync(Buffer.from(r.bytes));
  const slides = await Promise.all(Object.keys(zip.files).filter((n) => /ppt\/slides\/slide\d+\.xml$/.test(n)).map((n) => zip.file(n).async('string')));
  if (!slides.some((x) => x.includes(`descr="${DESC}"`))) throw new Error('not in PowerPoint');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
