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
const upload = (name, size, fill) => page.evaluate(async ([n, s, f]) => (await fetch(`/api/files/upload?name=${n}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: new Uint8Array(s).fill(f) })).json(), [name, size, fill]);
await step('the Storage window shows where space goes and the largest items', async () => {
  const big = await upload('video.bin', 300000, 1);
  await page.evaluate(async (id) => fetch(`/api/files/${id}/versions`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: new Uint8Array(400000).fill(2) }), big.id);
  await upload('note.txt', 10, 3);
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Storage' }).click();
  const d = page.getByRole('dialog', { name: 'Storage' });
  const list = d.getByRole('list', { name: 'Largest items' });
  await list.locator('li').first().getByText('video.bin').waitFor();
  await list.locator('li').first().getByText(/in 1 older version/).waitFor();
});
await step('delete older versions and move to trash from there', async () => {
  const d = page.getByRole('dialog', { name: 'Storage' });
  await d.getByRole('button', { name: 'Delete older versions' }).click();
  await page.getByText(/^Freed 29\d(\.\d)? KB$/).waitFor();
  await d.getByRole('button', { name: 'Move note.txt to trash' }).click();
  await page.getByText('Moved to trash').waitFor();
  await d.getByText('· in trash').waitFor();
  await d.getByRole('button', { name: 'Empty trash' }).click();
  await page.getByText('Trash emptied').waitFor();
  await page.waitForTimeout(500);
  if (await d.getByText('note.txt').count()) throw new Error('still listed');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
