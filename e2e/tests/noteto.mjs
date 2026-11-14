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
const card = (name) => page.getByRole('article', { name });
await step('a checklist note', async () => {
  await api(page, 'POST', '/notes', { title: 'Trip', items: [{ text: 'Book hotel' }, { text: 'Passport', done: true }, { text: 'Taxi' }] });
  await page.goto(`${B}/notes`);
  await card('Trip').waitFor();
});
await step('copy unticked items to Tasks', async () => {
  await card('Trip').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Copy unticked items to Tasks' }).click();
  await page.getByText('2 tasks added to My tasks').waitFor();
  await page.getByRole('button', { name: 'Open' }).click();
  await page.waitForURL(/\/tasks\//);
  await page.locator('.task', { hasText: 'Book hotel' }).waitFor();
  await page.locator('.task', { hasText: 'Taxi' }).waitFor();
});
await step('copy to a document', async () => {
  await page.goto(`${B}/notes`);
  await card('Trip').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Copy to a document' }).click();
  await page.getByText('Copied to a new document in My Drive').waitFor();
  await page.getByRole('button', { name: 'Open' }).click();
  await page.waitForURL(/\/docs\//);
  await page.locator('.ProseMirror h1', { hasText: 'Trip' }).waitFor();
  await page.locator('.ProseMirror li[data-checked="true"]', { hasText: 'Passport' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
