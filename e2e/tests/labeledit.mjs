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
await step('rename a label: on its notes, its colour kept, and into another merges', async () => {
  await api(page, 'POST', '/notes', { title: 'Plan', body: 'x', labels: ['Wrok'] });
  await api(page, 'POST', '/notes', { title: 'Groceries', body: 'y', labels: ['Home', 'Wrok'] });
  await api(page, 'PUT', '/notes/label-colors', { label: 'Wrok', color: '#d93025' });
  await page.goto(`${B}/notes`);
  await page.locator('article.note-card', { hasText: 'Plan' }).waitFor();
  const menu = async (l, item) => { const row = page.locator('.note-label-row', { hasText: l }); await row.hover(); await row.getByRole('button', { name: `Edit label ${l}` }).click(); await page.getByRole('menuitem', { name: item }).click(); };
  await menu('Wrok', 'Rename label…');
  const dlg = page.getByRole('dialog', { name: 'Rename label' });
  await dlg.getByLabel('Label name').fill('Work');
  await dlg.getByRole('button', { name: 'Rename' }).click();
  await page.locator('.note-label-row', { has: page.locator('.ellipsis', { hasText: /^Work$/ }) }).locator('.note-label-dot').waitFor();
  if (await page.locator('.note-label-row', { hasText: 'Wrok' }).count()) throw new Error('old name still there');
  await page.locator('article.note-card', { hasText: 'Plan' }).locator('.note-chip.coloured', { hasText: 'Work' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/label-rename.png` });
  // Home into Work: one label.
  await menu('Home', 'Rename label…');
  await page.getByRole('dialog', { name: 'Rename label' }).getByLabel('Label name').fill('Work');
  await page.getByRole('dialog', { name: 'Rename label' }).getByRole('button', { name: 'Rename' }).click();
  await until(async () => (await page.locator('.note-label-row').allInnerTexts()).length === 1);
  const chips = await page.locator('article.note-card', { hasText: 'Groceries' }).locator('.note-chip').allInnerTexts();
  if (chips.length !== 1) throw new Error(chips.join('|'));
});
await step('delete a label: off its notes, the notes stay', async () => {
  const row = page.locator('.note-label-row', { hasText: 'Work' });
  await row.locator('.subnav-item').click();
  await row.hover();
  await row.getByRole('button', { name: 'Edit label Work' }).click();
  await page.getByRole('menuitem', { name: 'Delete label' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete label' }).click();
  await until(async () => !(await page.locator('.note-label-row').count()));
  await page.locator('article.note-card', { hasText: 'Plan' }).waitFor(); // back to all notes
  if (await page.locator('.note-chip').count()) throw new Error('chips left');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
