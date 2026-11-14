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
const box = () => page.getByLabel('Search everything');
const results = () => page.getByRole('listbox', { name: 'Search results' });
const list = () => page.getByRole('listbox', { name: 'Search results' });
await step('quick actions: “new doc” makes a document and opens it', async () => {
  await page.goto(`${B}/drive`);
  await box().fill('new doc');
  await list().getByRole('group', { name: 'Actions' }).getByRole('option', { name: 'New document' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/searchactions.png` });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/docs\/[\w-]+$/);
  await page.locator('.ProseMirror').first().waitFor();
});
await step('“meeting” offers a new event, which opens the event window', async () => {
  await page.goto(`${B}/drive`);
  await box().fill('meeting');
  await list().getByRole('option', { name: 'New event' }).click();
  await page.getByRole('dialog', { name: 'New event' }).waitFor();
  await page.keyboard.press('Escape');
});
await step('searches are remembered: the empty box lists them, newest first; one is forgotten, then all', async () => {
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Quarterly budget' });
  await page.goto(`${B}/drive`);
  await box().fill('budget');
  await list().getByRole('option', { name: /Quarterly budget/ }).click();
  await page.waitForURL(/\/docs\//);
  await page.goto(`${B}/drive`);
  await box().fill('penang lease');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/drive\/search\?q=penang/);
  await box().fill('');
  await box().click();
  const rec = list().getByRole('group', { name: 'Recent searches' });
  await until(async () => (await rec.getByRole('option').allInnerTexts()).map((t) => t.trim()).filter(Boolean).join('|') === 'penang lease|budget');
  await rec.getByRole('option', { name: 'budget', exact: true }).click();
  if (await box().inputValue() !== 'budget') throw new Error('not searched again');
  await list().getByRole('option', { name: /Quarterly budget/ }).waitFor();
  await box().fill('');
  await rec.getByRole('option', { name: 'Forget “penang lease”' }).click();
  await until(async () => (await rec.getByRole('option').allInnerTexts()).map((t) => t.trim()).filter(Boolean).join('|') === 'budget');
  await page.getByRole('button', { name: 'Clear recent searches' }).click();
  await until(async () => (await api(page, 'GET', '/users/me/recent-searches')).body.length === 0);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
