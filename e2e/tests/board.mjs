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
let list;
const col = (name) => page.getByRole('region', { name, exact: true });
const card = (name, t) => col(name).locator('.board-card', { hasText: t });
await step('a list with tasks, shown as a board', async () => {
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Sprint' })).body.id;
  for (const t of ['Write spec', 'Design', 'Build']) await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: t });
  await page.goto(`${B}/tasks/${list}`);
  await page.getByRole('tab', { name: 'Board' }).click();
  for (const t of ['Write spec', 'Design', 'Build']) await card('To do', t).waitFor();
  if (await col('In progress').locator('.board-card').count()) throw new Error('in progress not empty');
});
await step('arrows move a card along', async () => {
  await page.getByRole('button', { name: 'Move “Design” to In progress' }).click();
  await card('In progress', 'Design').waitFor();
  await until(async () => (await api(page, 'GET', `/tasks/lists/${list}/tasks`)).body.find((t) => t.title === 'Design').started === true);
  await page.getByRole('button', { name: 'Move “Design” to Done' }).click();
  await card('Done', 'Design').waitFor();
  await page.getByText('“Design” done').waitFor();
});
await step('drag a card to another column', async () => {
  await card('To do', 'Build').dragTo(col('In progress'));
  await card('In progress', 'Build').waitFor();
  await card('Done', 'Design').dragTo(col('To do'));
  await card('To do', 'Design').waitFor();
  const all = (await api(page, 'GET', `/tasks/lists/${list}/tasks`)).body;
  const d = all.find((t) => t.title === 'Design');
  if (d.done || d.started) throw new Error(JSON.stringify(d));
});
await step('the board is remembered; the list shows In progress', async () => {
  await page.reload();
  await card('In progress', 'Build').waitFor();
  await page.getByRole('tab', { name: 'List' }).click();
  await page.locator('.task', { hasText: 'Build' }).getByText('In progress').waitFor();
  await page.reload();
  await page.locator('.task', { hasText: 'Build' }).waitFor();
});
await step('clicking a card opens its details', async () => {
  await page.getByRole('tab', { name: 'Board' }).click();
  await card('To do', 'Write spec').locator('.board-open').click();
  await page.getByRole('complementary', { name: 'Task details' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/board.png` });
});
await step('phone width scrolls the board, not the page', async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  if (w > 390) throw new Error(`page scrolls sideways: ${w}`);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
