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
let d1, d2;
const paper = (p = page) => p.locator('.paper.with-tabs');
const zoomOf = (p = page) => paper(p).evaluate((el) => getComputedStyle(el).zoom);
await step('zoom a document; it stays for you, in every document', async () => {
  d1 = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan' })).body;
  d2 = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Notes' })).body;
  await page.goto(`${B}/docs/${d1.id}`);
  await paper().waitFor();
  if (await zoomOf() !== '1') throw new Error(`zoom ${await zoomOf()}`);
  const w = (await paper().boundingBox()).width;
  await page.getByLabel('Zoom').selectOption('150');
  await until(async () => (await zoomOf()) === '1.5');
  const w2 = (await paper().boundingBox()).width;
  if (!(w2 > w * 1.3)) throw new Error(`width ${w} → ${w2}`);
  await page.screenshot({ path: `${SP}/shots/doc-zoom.png` });
  await page.waitForTimeout(500);
  await page.goto(`${B}/docs/${d2.id}`);
  await until(async () => (await zoomOf()) === '1.5');
  if (await page.getByLabel('Zoom').inputValue() !== '150') throw new Error('select');
});
await step('spell check can be turned off in Preferences', async () => {
  if (await paper().getAttribute('spellcheck') !== 'true') throw new Error('on by default');
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Preferences' }).click();
  const dlg = page.getByRole('dialog', { name: 'Preferences' });
  await dlg.getByLabel('Underline misspelt words (spell check)').uncheck();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await until(async () => (await paper().getAttribute('spellcheck')) === 'false');
  await page.reload();
  await paper().waitFor();
  await until(async () => (await paper().getAttribute('spellcheck')) === 'false');
  if (await zoomOf() !== '1.5') throw new Error('zoom kept too');
});
await step('a colleague who can only view has their own zoom', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const dir = (await api(page, 'GET', '/users/directory')).body;
  await api(page, 'PUT', `/files/${d1.id}/shares`, { shares: [{ user_id: dir.find((u) => u.username === 'kim@acme.com').id, role: 'viewer' }] });
  const kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/docs/${d1.id}`);
  await paper(kim).waitFor();
  await kim.waitForTimeout(800);
  if (await zoomOf(kim) !== '1') throw new Error('Kim starts at 100%');
  await kim.getByLabel('Zoom').selectOption('75');
  await until(async () => (await zoomOf(kim)) === '0.75');
  await page.reload();
  await until(async () => (await zoomOf()) === '1.5');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
