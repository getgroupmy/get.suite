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
let requestLink, folderId;
await step('a folder gets a file request link', async () => {
  folderId = (await api(page, 'POST', '/files/folder', { name: 'Client receipts' })).body.id;
  await api(page, 'POST', '/files/folder', { name: 'Private', parent_id: folderId });
  await page.goto(`${B}/drive`);
  await page.getByLabel('Actions for Client receipts').click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  const sec = page.getByRole('region', { name: 'Link sharing' });
  await sec.getByLabel('File request (upload only)').check();
  await sec.getByRole('button', { name: 'Create file request' }).click();
  await sec.getByText(/^File request \(upload only\) · /).waitFor();
  requestLink = await sec.getByLabel('Share link').inputValue();
  await sec.getByText(/^File request \(upload only\) · /).waitFor();
  await page.keyboard.press('Escape');
});
await step('someone without an account sends two files; they see nothing else', async () => {
  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  await v.goto(requestLink);
  await v.getByRole('heading', { name: 'Send files to Olivia Owner' }).waitFor();
  if (await v.getByText('Private').count()) throw new Error('folder contents shown');
  await v.getByLabel('Your name (so they know who sent them)').fill('Bob Client');
  await v.getByLabel('Choose files to send').setInputFiles([
    { name: 'taxi.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 taxi') },
    { name: 'hotel.png', mimeType: 'image/png', buffer: Buffer.from('not really a png') },
  ]);
  const sent = v.getByRole('list', { name: 'Files you sent' });
  await sent.locator('li.ok', { hasText: 'taxi.pdf' }).waitFor();
  await sent.locator('li.ok', { hasText: 'hotel.png' }).waitFor();
  await v.screenshot({ path: `${SP}/shots/file-request.png` });
  await ctx.close();
});
await step('the owner finds them in the folder, with who sent them, and a notification', async () => {
  await page.goto(`${B}/drive/folder/${folderId}`);
  await page.locator('table.files tr', { hasText: 'taxi.pdf' }).waitFor();
  await page.locator('table.files tr', { hasText: 'hotel.png' }).waitFor();
  const f = (await api(page, 'GET', `/files?parent=${folderId}`)).body;
  const taxi = (f.files || f).find((x) => x.name === 'taxi.pdf');
  if (taxi.description !== 'Sent by Bob Client through a file request') throw new Error(taxi.description);
  const bell = (await api(page, 'GET', '/notifications')).body;
  // Both files came from Bob: one notification counting them (grouped while unread).
  if (!(bell.items || bell).some((n) => n.title === 'Bob Client sent 2 files')) throw new Error(`no notification: ${JSON.stringify((bell.items || bell).map((n) => n.title))}`);
});
await step('removing the request stops it working', async () => {
  await page.goto(`${B}/drive`);
  await page.getByLabel('Actions for Client receipts').click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  await page.getByRole('region', { name: 'Link sharing' }).getByRole('button', { name: 'Remove link' }).click();
  await page.getByText('Link removed: it no longer works').waitFor();
  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  await v.goto(requestLink);
  await v.getByRole('heading', { name: 'Link not available' }).waitFor();
  await ctx.close();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
