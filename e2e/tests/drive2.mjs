import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
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
const row = (name) => page.locator('.files tbody tr', { hasText: name }).first();
let folderId;
await step('setup: a folder and some files', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  folderId = (await api(page, 'POST', '/files/folder', { name: 'Archive 2026' })).body.id;
  for (const n of ['a.txt', 'b.txt', 'c.txt']) await page.evaluate(async (name) => fetch(`/api/files/upload?name=${name}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: `file ${name}` }), n);
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Minutes' });
  await page.goto(`${B}/drive`);
  await row('c.txt').waitFor();
});
await step('Copy links: a line each; a file’s link opens its preview', async () => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: B });
  await page.getByLabel('Select c.txt').check();
  await page.getByLabel('Select Minutes').check();
  const bar = page.getByRole('toolbar', { name: 'Selected files' });
  await bar.getByRole('button', { name: 'Copy links' }).click();
  await page.locator('.toast', { hasText: '2 links copied' }).waitFor();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const lines = text.split('\n');
  const doc = lines.find((l) => l.startsWith('Minutes: ')), file = lines.find((l) => l.startsWith('c.txt: '));
  if (!doc || !/\/docs\/[\w-]+$/.test(doc) || !file || !/\/drive\?preview=[\w-]+$/.test(file)) throw new Error(text);
  await page.getByLabel('Select c.txt').uncheck();
  await page.getByLabel('Select Minutes').uncheck();
  await page.goto(file.slice('c.txt: '.length));
  await page.getByRole('dialog').getByText('c.txt').first().waitFor();
  if (/preview=/.test(page.url())) throw new Error('the link stays in the address: ' + page.url());
  await page.keyboard.press('Escape');
  await page.goto(`${B}/drive`);
  await row('c.txt').waitFor();
});
await step('a file’s ⋮ → Copy link', async () => {
  await row('b.txt').getByRole('button', { name: 'Actions for b.txt' }).click();
  await page.getByRole('menuitem', { name: 'Copy link' }).click();
  await page.locator('.toast', { hasText: 'Link copied' }).last().waitFor();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  if (!/^b\.txt: .*\/drive\?preview=[\w-]+$/.test(text)) throw new Error(text);
});
await step('Send in Chat…: the links wait in the conversation’s message box', async () => {
  const ch = (await api(page, 'POST', '/chat/channels', { name: 'design' })).body.id;
  await page.goto(`${B}/drive`);
  await page.getByLabel('Select c.txt').check();
  await page.getByRole('toolbar', { name: 'Selected files' }).getByRole('button', { name: 'Send in Chat…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Send “c.txt” in Chat' });
  await dlg.getByLabel('Conversation').selectOption({ label: '# design' });
  await dlg.getByRole('button', { name: 'Open in Chat' }).click();
  await page.waitForURL(new RegExp(`/chat/${ch}`));
  const box = page.getByRole('textbox', { name: 'Message' });
  await page.waitForFunction(() => /c\.txt: .*\/drive\?preview=/.test(document.querySelector('textarea[aria-label="Message"]')?.value || ''));
  await box.press('Enter');
  await page.locator('.file-card', { hasText: 'c.txt' }).waitFor();
  await page.goto(`${B}/drive`);
  await row('c.txt').waitFor();
});
await step('star a file; it shows in Starred', async () => {
  await row('Minutes').getByRole('button', { name: 'Actions for Minutes' }).click();
  await page.getByRole('menuitem', { name: 'Add star' }).click();
  await row('Minutes').locator('.star-mark').waitFor();
  await page.getByRole('link', { name: 'Starred' }).click();
  await page.getByRole('heading', { name: 'Starred' }).waitFor();
  await row('Minutes').waitFor();
  if (await page.locator('.files tbody tr').count() !== 1) throw new Error('only the starred one');
  await page.getByRole('link', { name: 'My Drive' }).click();
  await row('c.txt').waitFor();
});
await step('make a copy', async () => {
  await row('a.txt').getByRole('button', { name: 'Actions for a.txt' }).click();
  await page.getByRole('menuitem', { name: 'Make a copy' }).click();
  await row('Copy of a.txt').waitFor();
});
await step('select several; download them as a zip; move them into a folder', async () => {
  await page.getByLabel('Select a.txt').check();
  await page.getByLabel('Select b.txt').check();
  await page.getByRole('toolbar', { name: 'Selected files' }).getByText('2 selected').waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('toolbar', { name: 'Selected files' }).getByRole('button', { name: 'Download' }).click()]);
  const JSZip = require(`${ROOT}/server/node_modules/jszip`);
  const zip = await JSZip.loadAsync(require('node:fs').readFileSync(await dl.path()));
  if (Object.keys(zip.files).sort().join() !== 'a.txt,b.txt') throw new Error(Object.keys(zip.files).join());
  await page.screenshot({ path: `${SP}/shots/drive-select.png` });
  await page.getByRole('toolbar', { name: 'Selected files' }).getByRole('button', { name: 'Move' }).click();
  const dlg = page.getByRole('dialog', { name: 'Move 2 items' });
  await dlg.getByRole('button', { name: /Archive 2026/ }).click();
  await dlg.getByRole('button', { name: 'Move here' }).click();
  await until(async () => (await page.locator('.files tbody tr', { hasText: /^a\.txt/ }).count()) === 0);
  const inside = (await api(page, 'GET', `/files?view=mine&parent=${folderId}`)).body.map((f) => f.name).sort();
  if (inside.join() !== 'a.txt,b.txt') throw new Error(inside.join());
});
await step('drag a file onto a folder to move it', async () => {
  await row('c.txt').dragTo(row('Archive 2026'));
  await until(async () => (await api(page, 'GET', `/files?view=mine&parent=${folderId}`)).body.some((f) => f.name === 'c.txt'));
  await page.getByText('Moved 1 item').waitFor();
});
await step('download a folder as a zip', async () => {
  await row('Archive 2026').getByRole('button', { name: 'Actions for Archive 2026' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as .zip' }).click()]);
  if (dl.suggestedFilename() !== 'Archive 2026.zip') throw new Error(dl.suggestedFilename());
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
