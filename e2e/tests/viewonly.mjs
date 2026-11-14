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
await step('setup: a colleague', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
let doc, pdf;
await step('the owner turns off downloading, printing and copying for viewers, in Share', async () => {
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Board strategy' })).body;
  pdf = await page.evaluate(async () => (await (await fetch('/api/files/upload?name=board-pack.pdf', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: '%PDF-1.4 x' })).json()));
  for (const f of [doc, pdf]) await api(page, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByRole('button', { name: 'Share' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Viewers and commenters can download, print and copy').uncheck();
  await page.getByText('Viewers and commenters can only look at it now').waitFor();
  await api(page, 'PATCH', `/files/${pdf.id}`, { no_download: true });
});
await step('Kim, a viewer, can read it but isn\'t offered downloading, printing or a copy', async () => {
  await kim.goto(`${B}/docs/${doc.id}`);
  await kim.getByRole('note').getByText('View only: the owner has turned off downloading, printing and copying.').waitFor();
  await kim.getByRole('button', { name: 'More' }).click();
  await kim.getByRole('menuitem').first().waitFor();
  const labels = await kim.getByRole('menuitem').allInnerTexts();
  if (labels.some((l) => /Download|Print/.test(l))) throw new Error(labels.join(' | '));
  await kim.keyboard.press('Escape');
  const r = await api(kim, 'GET', `/files/${doc.id}/export?format=docx`);
  if (r.status !== 403) throw new Error('export ' + r.status);
  await kim.goto(`${B}/drive/shared`);
  const row = kim.locator('tr', { hasText: 'board-pack.pdf' });
  await row.waitFor();
  await row.getByRole('button').last().click();
  await kim.getByRole('menuitem', { name: 'Open' }).first().waitFor();
  if (await kim.getByRole('menuitem', { name: 'Download' }).count()) throw new Error('Download offered');
  if (await kim.getByRole('menuitem', { name: 'Make a copy' }).count()) throw new Error('copy offered');
}, kim);
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
