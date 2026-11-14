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
const sec = () => page.getByRole('region', { name: 'Link sharing' });
await step('a file request for PDFs and pictures, up to 1 MB, with a note', async () => {
  folderId = (await api(page, 'POST', '/files/folder', { name: 'Expenses' })).body.id;
  await page.goto(`${B}/drive`);
  await page.getByLabel('Actions for Expenses').click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  await sec().getByLabel('File request (upload only)').check();
  const limits = sec().getByRole('group', { name: 'What it takes' });
  await limits.getByLabel('PDFs').check();
  await limits.getByLabel('Pictures').check();
  await limits.getByText('Takes PDFs or pictures').waitFor();
  await limits.getByLabel('Largest file (MB, empty for any size)').fill('1');
  await limits.getByLabel('A note for the people sending (shown on the page)').fill('Your receipts for October, please.');
  await page.screenshot({ path: `${SP}/shots/request-limits.png` });
  await sec().getByRole('button', { name: 'Create file request' }).click();
  await sec().getByText(/File request \(upload only\) · Takes PDFs or pictures, up to 1 MB each · With a note/).waitFor();
  requestLink = await sec().getByLabel('Share link').inputValue();
  await page.keyboard.press('Escape');
});
let v, ctx;
await step('the sender sees the note and what it takes; the picker is limited; wrong kinds and big files are refused at once', async () => {
  ctx = await browser.newContext();
  v = await ctx.newPage();
  await v.goto(requestLink);
  await v.getByRole('heading', { name: 'Send files to Olivia Owner' }).waitFor();
  await v.getByText('Your receipts for October, please.').waitFor();
  await v.getByText('Takes PDFs or pictures').waitFor();
  await v.getByText(', up to 1 MB each.').waitFor();
  const accept = await v.getByLabel('Choose files to send').getAttribute('accept');
  if (!accept.startsWith('.pdf,.jpg')) throw new Error(accept);
  await v.getByLabel('Your name (so they know who sent them)').fill('Bob Client');
  await v.getByLabel('Choose files to send').setInputFiles([
    { name: 'taxi.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 taxi') },
    { name: 'notes.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('PK') },
    { name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(1100 * 1024, 1) },
    { name: 'receipt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('MZ\x90 a renamed program') },
  ]);
  const sent = v.getByRole('list', { name: 'Files you sent' });
  await sent.locator('li.ok', { hasText: 'taxi.pdf' }).waitFor();
  await sent.locator('li.error', { hasText: "notes.docx can't be sent here: this request only takes PDFs or pictures" }).waitFor();
  await sent.locator('li.error', { hasText: 'scan.pdf is too large: files can be at most 1 MB here' }).waitFor();
  await sent.locator('li.error', { hasText: "receipt.pdf doesn't look like the kind of file its name says, so it wasn't sent" }).waitFor();
  await v.screenshot({ path: `${SP}/shots/request-page.png` });
  const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
  for (const scheme of ['light', 'dark']) {
    await v.emulateMedia({ colorScheme: scheme });
    await v.addScriptTag({ content: AXE });
    const r = await v.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 100)}`));
    if (r.length) throw new Error(`${scheme}: ${r.join(' | ')}`);
  }
});
await step('only the PDF arrived; the server refuses a wrong kind even when the page is bypassed', async () => {
  const inside = (await api(page, 'GET', `/files?parent=${folderId}`)).body;
  const names = (inside.files || inside).map((f) => f.name);
  if (JSON.stringify(names) !== '["taxi.pdf"]') throw new Error(JSON.stringify(names));
  const token = requestLink.split('/').pop();
  const r = await v.evaluate(async (t) => (await fetch(`/api/public/links/${t}/upload?name=evil.exe`, { method: 'POST', body: 'MZ', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' } })).status, token);
  if (r !== 415) throw new Error(String(r));
});
await step('the owner changes what it takes (⚙), keeping the link; the page follows', async () => {
  await page.goto(`${B}/drive`);
  await page.getByLabel('Actions for Expenses').click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  await sec().getByRole('button', { name: 'What it takes' }).click();
  const dlg = page.getByRole('dialog', { name: 'What the file request takes' });
  await dlg.getByLabel('Pictures').uncheck();
  await dlg.getByLabel('Spreadsheets').check();
  await dlg.getByLabel('Largest file (MB, empty for any size)').fill('');
  await dlg.getByLabel('A note for the people sending (shown on the page)').fill('');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.getByText('File request changed: same link').waitFor();
  await sec().getByText(/File request \(upload only\) · Takes PDFs or spreadsheets · /).waitFor();
  if (await sec().getByLabel('Share link').inputValue() !== requestLink) throw new Error('link changed');
  await v.reload();
  await v.getByText('Takes PDFs or spreadsheets').waitFor();
  if (await v.getByText('Your receipts for October').count()) throw new Error('old note');
  await ctx.close();
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
