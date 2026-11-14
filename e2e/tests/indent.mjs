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
let docId;
const para = (t) => page.locator('.ProseMirror p, .ProseMirror h2').filter({ hasText: t }).first();
const margin = (t) => para(t).evaluate((el) => getComputedStyle(el).marginLeft);
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
  const content = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Dear Kim,' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'A quoted passage to set in.' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A list item' }] }] }] },
  ] };
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Letter', content })).body.id;
  await page.goto(`${B}/docs/${docId}`);
  await para('A quoted passage').waitFor();
});
await step('Ctrl+] sets a paragraph in, twice goes further; Ctrl+[ brings it back', async () => {
  await para('A quoted passage').click();
  await page.keyboard.press('Control+]');
  await until(async () => (await margin('A quoted passage')) === '36px');
  await page.keyboard.press('Control+]');
  await until(async () => (await margin('A quoted passage')) === '72px');
  await page.getByRole('button', { name: 'Decrease indent (Ctrl+[)' }).click();
  await until(async () => (await margin('A quoted passage')) === '36px');
  if ((await margin('Dear Kim')) !== '0px') throw new Error('other paragraphs stay');
  await page.screenshot({ path: `${SP}/shots/indent.png` });
});
await step('kept after a reload, and in the saved document', async () => {
  await until(async () => JSON.stringify((await api(page, 'GET', `/files/${docId}/content`)).body.content).includes('"indent":1'));
  await page.reload();
  await para('A quoted passage').waitFor();
  await until(async () => (await margin('A quoted passage')) === '36px');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
