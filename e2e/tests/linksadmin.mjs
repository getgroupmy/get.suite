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
let kim, link, req;
await step('Admin → Share links lists the company’s links: file, who made it, kind, until when', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  const file = (await kim.evaluate(async () => (await fetch('/api/files/upload?name=price-list.csv', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: 'a,b' })).json()));
  link = (await api(kim, 'POST', '/links', { file_id: file.id, password: 'sesame-12', expires_at: Date.now() + 7 * 864e5 })).body;
  const folder = (await api(kim, 'POST', '/files/folder', { name: 'Receipts' })).body;
  req = (await api(kim, 'POST', '/links', { file_id: folder.id, mode: 'upload' })).body;
  await page.goto(`${B}/admin?tab=links`);
  const table = page.getByRole('table', { name: 'Share links' });
  await table.waitFor();
  const rows = await table.locator('tbody tr').allInnerTexts();
  if (rows.length !== 2) throw new Error(rows.join(' | '));
  const p = rows.find((r) => r.includes('price-list.csv')), r = rows.find((x) => x.includes('Receipts'));
  if (!/Kim Park/.test(p) || !/View and download/.test(p) || !/password/.test(p) || /No expiry/.test(p)) throw new Error(p);
  if (!/File request/.test(r) || !/No expiry/.test(r)) throw new Error(r);
  await page.screenshot({ path: `${SP}/shots/links-admin.png` });
});
await step('Stop: the link stops working and Kim is told', async () => {
  await page.getByRole('button', { name: 'Stop the link to price-list.csv by Kim Park' }).click();
  await page.getByRole('dialog', { name: 'Stop this link?' }).getByRole('button', { name: 'Stop link' }).click();
  await page.getByText('Link stopped').waitFor();
  await until(async () => (await page.getByRole('table', { name: 'Share links' }).locator('tbody tr').count()) === 1);
  const r = await page.evaluate(async (t) => (await fetch(`/api/public/links/${t}`)).status, link.token);
  if (r !== 404) throw new Error(`still works: ${r}`);
  const n = (await api(kim, 'GET', '/notifications')).body;
  if (!JSON.stringify(n).includes('An admin stopped your link to price-list.csv')) throw new Error('not told');
});
await step('a member doesn’t get the list', async () => {
  const r = await api(kim, 'GET', '/links/all');
  if (r.status !== 403) throw new Error(String(r.status));
});
await step('company rules: links within 10 days, with a password; Drive’s Share follows them', async () => {
  await page.goto(`${B}/admin?tab=company`);
  const days = page.getByLabel('Links must expire within days');
  await days.fill('10');
  await days.blur();
  await page.getByText('Links must now expire within 10 days').waitFor();
  await page.getByLabel('Require a password on every link').check();
  await page.getByText('Links now need a password').waitFor();
  await page.reload();
  if (await page.getByLabel('Links must expire within days').inputValue() !== '10') throw new Error('not kept');
  await api(page, 'POST', '/files/folder', { name: 'Contracts' });
  await page.goto(`${B}/drive`);
  await page.getByLabel('Actions for Contracts').click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  const sec = page.getByRole('region', { name: 'Link sharing' });
  await sec.getByText('Your company asks for links that expire within 10 days and a password on every link.').waitFor();
  const opts = await sec.getByLabel('Link expiry').locator('option').allInnerTexts();
  if (opts.join('|') !== 'Expires in 1 day|Expires in 7 days') throw new Error(opts.join('|'));
  const pw = sec.getByLabel('Password', { exact: true });
  if (!(await pw.isChecked()) || !(await pw.isDisabled())) throw new Error('password not required');
  if (!(await sec.getByRole('button', { name: 'Create link' }).isDisabled())) throw new Error('can create without a password');
  await sec.getByLabel('Link password').fill('contract-77');
  await sec.getByRole('button', { name: 'Create link' }).click();
  await sec.getByLabel('Share link').waitFor();
  if (await sec.getByRole('button', { name: 'Remove password' }).count()) throw new Error('could remove it');
  await page.screenshot({ path: `${SP}/shots/link-rules.png` });
});
await step('apply the rules to existing links: Kim’s file request without a password stops; Kim is told', async () => {
  await page.goto(`${B}/admin?tab=links`);
  await page.getByText('1 working link made before your company’s rules doesn’t follow them.').waitFor();
  await page.getByRole('button', { name: 'Apply the rules to existing links…' }).click();
  const d = page.getByRole('dialog', { name: 'Apply the rules to existing links?' });
  await d.getByText(/Links without a password stop working/).waitFor();
  await d.getByRole('button', { name: 'Apply rules' }).click();
  await page.getByText('1 stopped, 0 shortened').waitFor();
  const rows = await page.getByRole('table', { name: 'Share links' }).locator('tbody tr').allInnerTexts();
  if (rows.length !== 1 || !/Contracts/.test(rows[0])) throw new Error(rows.join(' | '));
  if (await page.getByRole('button', { name: 'Apply the rules to existing links…' }).count()) throw new Error('still offered');
  const r = await page.evaluate(async (t) => (await fetch(`/api/public/links/${t}`)).status, req.token);
  if (r !== 404) throw new Error(`request still works: ${r}`);
  if (!JSON.stringify((await api(kim, 'GET', '/notifications')).body).includes('stopped 1 link without a password (Receipts)')) throw new Error('Kim not told');
});
await step('/drive?share=<id> (from “your link stops working soon”) opens that file’s Share window', async () => {
  const id = (await api(page, 'GET', '/files?view=mine')).body.find((f) => f.name === 'Contracts').id;
  await page.goto(`${B}/drive?share=${id}`);
  const sec = page.getByRole('region', { name: 'Link sharing' });
  await sec.waitFor();
  await sec.getByLabel('Share link').waitFor();
  if (page.url().includes('share=')) throw new Error('the address keeps it');
});
await step('🔕 → 🔔: tell me when it’s opened; a visitor opens it and Olivia is told', async () => {
  const sec = page.getByRole('region', { name: 'Link sharing' });
  const btn = sec.getByRole('button', { name: 'Tell me when it’s opened' });
  if (await btn.getAttribute('aria-pressed') !== 'false') throw new Error('on already');
  await btn.click();
  await page.getByText('You’ll be told when it’s opened').waitFor();
  if (await btn.getAttribute('aria-pressed') !== 'true') throw new Error('not on');
  const url = await sec.getByLabel('Share link').inputValue();
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(url);
  await visitor.getByLabel(/Password/i).first().fill('contract-77');
  await visitor.keyboard.press('Enter');
  await visitor.getByText('Contracts').first().waitFor();
  await until(async () => JSON.stringify((await api(page, 'GET', '/notifications')).body).includes('Your link to Contracts was opened'));
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: /Notifications/ }).first().click();
  await page.getByText('Your link to Contracts was opened').first().waitFor();
  await page.screenshot({ path: `${SP}/shots/link-opened.png` });
});
await step('Drive → Shared by link: Olivia’s own links (not Kim’s); Share… opens it; remove one', async () => {
  await page.goto(`${B}/drive`);
  await page.getByRole('link', { name: 'Shared by link' }).click();
  await page.waitForURL('**/drive/links');
  const table = page.getByRole('table', { name: 'Your share links' });
  await table.waitFor();
  const rows = await table.locator('tbody tr').allInnerTexts();
  if (rows.length !== 1 || !/Contracts/.test(rows[0]) || !/🔑/.test(rows[0]) || !/🔔/.test(rows[0])) throw new Error(rows.join(' | '));
  if (rows.some((r) => /Receipts|price-list/.test(r))) throw new Error('someone else’s');
  await table.getByRole('button', { name: 'Share settings for Contracts' }).click();
  await page.getByRole('region', { name: 'Link sharing' }).waitFor();
  await page.goBack();
  await page.goto(`${B}/drive/links`);
  await page.getByRole('table', { name: 'Your share links' }).getByRole('button', { name: 'Remove the link to Contracts' }).click();
  await page.getByText('No links').waitFor();
  await page.getByLabel('Show expired links too').check();
  await page.getByText('You haven’t made any.').waitFor();
});
await step('Download (CSV): every link, as a spreadsheet', async () => {
  const fid = (await api(page, 'POST', '/files/folder', { name: 'Audit folder' })).body.id;
  const mk2 = await api(page, 'POST', '/links', { file_id: fid, password: 'audit-1234', expires_at: Date.now() + 5 * 864e5 });
  if (mk2.status !== 200) throw new Error(JSON.stringify(mk2.body));
  await page.goto(`${B}/admin?tab=links`);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download (CSV)' }).click()]);
  if (dl.suggestedFilename() !== 'share-links.csv') throw new Error(dl.suggestedFilename());
  const text = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  const lines = text.replace(/^\ufeff/, '').trim().split('\r\n');
  if (!lines[0].startsWith('File or folder,Kind,Made by')) throw new Error(lines[0]);
  const row = lines.find((l) => l.startsWith('Audit folder,'));
  if (!row || !/View and download \(folder\),Olivia Owner,olivia@acme.com,\/s\/[\w-]+,yes,/.test(row) || lines.length !== 2) throw new Error(lines.join(' | '));
});
await step('Made by Kim Park → only Kim’s links; Stop all of them; Olivia’s stay', async () => {
  for (const n of ['Plans A', 'Plans B']) {
    const fid = (await api(kim, 'POST', '/files/folder', { name: n })).body.id;
    const r = await api(kim, 'POST', '/links', { file_id: fid, password: 'kim-12345', expires_at: Date.now() + 3 * 864e5 });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  }
  await page.goto(`${B}/admin?tab=links`);
  const table = page.getByRole('table', { name: 'Share links' });
  await until(async () => (await table.locator('tbody tr').count()) === 3);
  await page.getByLabel('Made by').selectOption({ label: 'Kim Park' });
  await until(async () => (await table.locator('tbody tr').count()) === 2);
  await page.getByRole('button', { name: 'Stop all of Kim Park’s links…' }).click();
  await page.getByRole('dialog', { name: 'Stop all of Kim Park’s links?' }).getByRole('button', { name: 'Stop all' }).click();
  await page.getByText('2 links stopped').waitFor();
  await until(async () => (await table.locator('tbody tr').count()) === 1);
  if (!/Audit folder/.test(await table.locator('tbody tr').first().innerText())) throw new Error('Olivia’s link went');
  if (!JSON.stringify((await api(kim, 'GET', '/notifications')).body).includes('An admin stopped your 2 links')) throw new Error('Kim not told');
});
await step('find a file’s links by part of its name', async () => {
  const fid = (await api(page, 'POST', '/files/folder', { name: 'Brochures 2026' })).body.id;
  await api(page, 'POST', '/links', { file_id: fid, password: 'broch-1234', expires_at: Date.now() + 3 * 864e5 });
  await page.goto(`${B}/admin?tab=links`);
  const table = page.getByRole('table', { name: 'Share links' });
  await until(async () => (await table.locator('tbody tr').count()) === 2);
  await page.getByLabel('File or folder').fill('brochures');
  await until(async () => (await table.locator('tbody tr').count()) === 1);
  if (!/Brochures 2026/.test(await table.locator('tbody tr').first().innerText())) throw new Error('wrong one');
  await page.getByLabel('File or folder').fill('nothing like it');
  await page.getByText('No working links.').waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
