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
await step('switch notes to one column and back; kept after a reload', async () => {
  for (const t of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota']) await api(page, 'POST', '/notes', { title: t, body: 'x\ny\nz' });
  await page.goto(`${B}/notes`);
  const grid = page.getByLabel('Notes', { exact: true });
  await page.locator('article.note-card', { hasText: 'Gamma' }).waitFor();
  const lefts = async () => [...new Set(await page.locator('article.note-card').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left))))];
  if ((await lefts()).length < 2) throw new Error('grid should have several columns');
  await page.getByRole('button', { name: 'List view' }).click();
  await until(async () => (await lefts()).length === 1);
  if (!(await grid.getAttribute('class')).includes('list')) throw new Error('no list class');
  await page.screenshot({ path: `${SP}/shots/notes-list.png` });
  await page.reload();
  await page.getByRole('button', { name: 'Grid view' }).waitFor();
  await until(async () => (await lefts()).length === 1);
  await page.getByRole('button', { name: 'Grid view' }).click();
  await until(async () => (await lefts()).length > 1);
});
await step('sort notes by title, then last edited; kept after a reload; dragging only in your order', async () => {
  const titles = async () => (await page.locator('article.note-card h3').allInnerTexts());
  await page.getByLabel('Sort notes').selectOption({ label: 'Title' });
  await until(async () => (await titles()).slice(0, 3).join('|') === 'Alpha|Beta|Delta');
  await until(async () => (await page.locator('article.note-card[draggable="true"]').count()) === 0).catch(() => { throw new Error('draggable while sorted'); });
  const all = (await api(page, 'GET', '/notes')).body;
  const zeta = (Array.isArray(all) ? all : all.notes).find((n) => n.title === 'Zeta');
  await api(page, 'PATCH', `/notes/${zeta.id}`, { body: 'changed' });
  await page.getByLabel('Sort notes').selectOption({ label: 'Last edited' });
  await until(async () => (await titles())[0] === 'Zeta');
  await page.reload();
  await until(async () => (await titles())[0] === 'Zeta');
  await page.getByLabel('Sort notes').selectOption({ label: 'Your order' });
  await page.locator('article.note-card[draggable="true"]').first().waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
