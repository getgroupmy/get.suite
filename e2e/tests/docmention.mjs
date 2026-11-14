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
let doc;
await step('typing @ and a name puts a person in the document and tells them', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' });
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Brief' })).body;
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Over to @ki');
  const list = page.getByRole('listbox', { name: 'People, dates and files' });
  await list.getByRole('option', { name: /Kim Park/ }).waitFor();
  await page.keyboard.press('Enter');
  await page.locator('.ProseMirror .doc-mention', { hasText: '@Kim Park' }).waitFor();
  await page.getByText('Kim Park was told').waitFor();
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  if (!JSON.stringify((await api(kim, 'GET', '/notifications')).body).includes('Olivia Owner mentioned you in “Brief”')) throw new Error('not told');
});
await step('someone who can’t open it: offered to share', async () => {
  await page.keyboard.type('and @Lee');
  await page.getByRole('listbox', { name: 'People, dates and files' }).getByRole('option', { name: /Lee Chan/ }).click();
  await page.locator('.ProseMirror .doc-mention', { hasText: '@Lee Chan' }).waitFor();
  await page.getByText('Lee Chan can\'t open this document').waitFor();
  await page.getByRole('button', { name: 'Share with them' }).click();
  await page.getByText('Shared with Lee Chan (can edit), and they were told').waitFor();
});
await step('the mention is kept and shows in the Markdown download', async () => {
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'More' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as Markdown (.md)' }).click()]);
  const text = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  if (!text.includes('Over to @Kim Park and @Lee Chan')) throw new Error(JSON.stringify(text));
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
