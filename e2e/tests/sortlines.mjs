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
const p = (text, marks) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(marks && { marks }) }] });
const li = (text) => ({ type: 'listItem', content: [p(text)] });
const texts = (sel) => page.locator(sel).allInnerTexts();
let doc;
await step('select paragraphs and sort them A → Z (numbers as numbers, bold kept)', async () => {
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Lists' })).body;
  const c = (await api(page, 'GET', `/files/${doc.id}/content`)).body;
  await api(page, 'PUT', `/files/${doc.id}/content`, { version: c.file.version, content: { type: 'doc', content: [
    p('Item 10'), p('Item 2', [{ type: 'bold' }]), p('item 1'),
    { type: 'bulletList', content: [li('pear'), li('Apple'), li('banana')] },
  ] } });
  await page.goto(`${B}/docs/${doc.id}`);
  const ps = page.locator('.ProseMirror > p');
  await ps.first().waitFor();
  await ps.first().click();
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift');
  await ps.nth(2).click();
  await page.keyboard.press('End');
  await page.keyboard.up('Shift');
  await page.getByLabel('Sort lines').selectOption('asc');
  await until(async () => (await texts('.ProseMirror > p')).join('|') === 'item 1|Item 2|Item 10');
  if (await page.locator('.ProseMirror > p strong', { hasText: 'Item 2' }).count() !== 1) throw new Error('bold lost');
});
await step('a list, Z → A; Ctrl+Z puts it back', async () => {
  const items = page.locator('.ProseMirror ul li');
  await items.first().click();
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift');
  await items.nth(2).click();
  await page.keyboard.press('End');
  await page.keyboard.up('Shift');
  await page.getByLabel('Sort lines').selectOption('desc');
  await until(async () => (await texts('.ProseMirror ul li')).join('|') === 'pear|banana|Apple');
  await page.screenshot({ path: `${SP}/shots/sort-lines.png` });
  await page.keyboard.press('Control+z');
  await until(async () => (await texts('.ProseMirror ul li')).join('|') === 'pear|Apple|banana');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
