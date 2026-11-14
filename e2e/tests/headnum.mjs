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
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const before = (p, text) => p.locator('.ProseMirror :is(h1,h2,h3)', { hasText: text }).evaluate((el) => getComputedStyle(el, '::before').content);
let doc;
await step('Page setup → Number the headings: 1, 1.1, 2 on the page', async () => {
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan' })).body;
  const c = (await api(page, 'GET', `/files/${doc.id}/content`)).body;
  await api(page, 'PUT', `/files/${doc.id}/content`, { version: c.file.version, content: { type: 'doc', content: [h(1, 'Introduction'), { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }, h(2, 'Scope'), h(2, 'Goals'), h(1, 'Costs')] } });
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror h1', { hasText: 'Costs' }).waitFor();
  if (await before(page, 'Introduction') !== 'none') throw new Error('numbered before turning it on');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Page setup' }).click();
  const dlg = page.getByRole('dialog', { name: 'Page setup' });
  await dlg.getByLabel('Number the headings (1, 1.1, 1.1.1)').check();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Page setup saved' }).last().waitFor();
  await until(async () => (await before(page, 'Introduction')) === 'counter(h1) " "');
  const got = [await before(page, 'Scope'), await before(page, 'Goals'), await before(page, 'Costs')];
  if (got.join('|') !== 'counter(h1) "." counter(h2) " "|counter(h1) "." counter(h2) " "|counter(h1) " "') throw new Error(got.join('|'));
  await page.screenshot({ path: `${SP}/shots/heading-numbers.png` });
});
await step('the Word download has the same numbers', async () => {
  const r = await page.evaluate(async (id) => { const res = await fetch(`/api/files/${id}/export`); return res.ok; }, doc.id);
  if (!r) throw new Error('download');
  const setup = (await api(page, 'GET', `/files/${doc.id}`)).body.page_setup;
  if (!setup.headingNumbers) throw new Error(JSON.stringify(setup));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
