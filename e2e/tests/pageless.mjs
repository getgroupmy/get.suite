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
let docId, kim;
const paperW = (p) => p.locator('.paper').evaluate((el) => Math.round(el.getBoundingClientRect().width));
await step('setup: a document shared with an editor', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Report', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quarterly figures' }] }] } })).body.id;
  await api(page, 'PUT', `/files/${docId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/docs/${docId}`); await p.getByText('Quarterly figures').waitFor(); }
});
const setup = async (fn) => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Page setup' }).click();
  const dlg = page.getByRole('dialog', { name: 'Page setup' });
  await fn(dlg);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Page setup saved' }).last().waitFor();
};
await step('Pageless: the paper spans the window, for everyone', async () => {
  const before = await paperW(page);
  if (before > 900) throw new Error('paper first: ' + before);
  await setup(async (dlg) => { await dlg.getByRole('radio', { name: 'Pageless' }).click(); await dlg.getByText('one long sheet').waitFor(); });
  await until(async () => (await paperW(page)) > 1000);
  await until(async () => (await paperW(kim)) > 1000);
  const shadow = await page.locator('.paper').evaluate((el) => getComputedStyle(el).boxShadow);
  if (shadow !== 'none') throw new Error('shadow ' + shadow);
  const saved = (await api(page, 'GET', `/files/${docId}`)).body.page_setup;
  if (!saved.pageless || saved.size !== 'a4') throw new Error(JSON.stringify(saved));
  await page.screenshot({ path: `${SP}/shots/pageless.png` });
});
await step('printing still uses the paper; Pages brings the page back', async () => {
  await page.emulateMedia({ media: 'print' });
  await page.emulateMedia({ media: 'screen' });
  await setup(async (dlg) => { if ((await dlg.getByRole('radio', { name: 'Pageless' }).getAttribute('aria-checked')) !== 'true') throw new Error('dialog should show it'); await dlg.getByRole('radio', { name: 'Pages' }).click(); });
  await until(async () => (await paperW(page)) < 900);
  await until(async () => (await paperW(kim)) < 900);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
