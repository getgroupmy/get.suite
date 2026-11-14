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
let deckId;
await step('comment on the second slide of a presentation', async () => {
  await page.goto(B + '/drive');
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('menuitem', { name: 'Presentation' }).click();
  await page.waitForURL(/\/slides\//);
  deckId = page.url().split('/').pop();
  await page.getByText('Click to add title').waitFor();
  await page.getByRole('button', { name: 'New slide' }).click();
  await page.getByRole('menuitem').first().click();
  await page.getByRole('button', { name: 'Slide 2', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Comment on this slide' }).click();
  const panel = page.getByRole('complementary', { name: 'Comments' });
  await panel.getByText('On slide 2').waitFor();
  await panel.getByLabel('New comment').fill('Move the chart here');
  await panel.getByRole('button', { name: 'Comment', exact: true }).click();
  await panel.getByText('Move the chart here').waitFor();
  await page.getByRole('button', { name: /Comments \(1\)/ }).waitFor();
  await page.locator('.slide-list li').nth(1).locator('[title="1 open comment"]').waitFor();
});
await step('the comment follows its slide when slides move, and takes you there', async () => {
  await page.getByRole('button', { name: 'Options for slide 2' }).click();
  await page.getByRole('menuitem', { name: 'Move up' }).click();
  await page.locator('.slide-list li').nth(0).locator('[title="1 open comment"]').waitFor();
  await page.getByRole('button', { name: 'Slide 2', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Comments' });
  await panel.getByRole('button', { name: 'Slide 1', exact: true }).click();
  await page.getByText('Slide 1 of 2').waitFor();
});
await step('opened from a link to the comment, on its slide', async () => {
  const c = (await api(page, 'GET', `/comments/${deckId}`)).body[0];
  await page.getByRole('button', { name: 'Options for slide 1' }).click();
  await page.getByRole('menuitem', { name: 'Move down' }).click();
  await page.locator('.slide-list li').nth(1).locator('[title="1 open comment"]').waitFor();
  await page.waitForTimeout(2500); // saved
  await page.goto(`${B}/slides/${deckId}?comment=${c.id}`);
  await page.getByRole('complementary', { name: 'Comments' }).getByText('Move the chart here').waitFor();
  await page.getByText('Slide 2 of 2').waitFor();
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
