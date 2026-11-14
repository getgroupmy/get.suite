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
let noteId;
const cardOf = (p, name) => p.getByRole('article', { name, exact: true });
const items = async () => (await api(page, 'GET', '/notes')).body.find((n) => n.id === noteId).items.map((i) => `${i.indent ? '>' : ''}${i.text}${i.done ? '*' : ''}`).join(' ');
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
  noteId = (await api(page, 'POST', '/notes', { title: 'Trip', items: ['Pack', 'Socks', 'Charger', 'Book train'].map((text) => ({ text })) })).body.id;
  await page.goto(`${B}/notes`);
  await cardOf(page, 'Trip').waitFor();
});
await step('Tab makes sub-items; Alt+↑ moves an item with its sub-items', async () => {
  await cardOf(page, 'Trip').locator('.note-open').click();
  const dlg = page.getByRole('dialog', { name: 'Trip' });
  await dlg.getByLabel('List item 2', { exact: true }).press('Tab');
  await dlg.getByLabel('List item 3', { exact: true }).press('Tab');
  await dlg.getByLabel('List item 2 (sub-item)').waitFor();
  await dlg.getByLabel('List item 4', { exact: true }).press('Alt+ArrowUp');
  await until(async () => (await dlg.locator('input[aria-label^="List item 1"]').inputValue()) === 'Book train');
  await dlg.getByLabel('List item 2', { exact: true }).press('Enter'); // after Pack: a new main item
  await page.keyboard.type('Passport');
  await page.keyboard.press('Shift+Tab'); // already a main item: nothing happens
  await page.screenshot({ path: `${SP}/shots/checklist-edit.png` });
  await dlg.getByRole('button', { name: 'Close' }).last().click();
  await until(async () => (await items()) === 'Book train Pack Passport >Socks >Charger');
});
await step('Alt+↑ on a main item takes its sub-items along; ticking it ticks them', async () => {
  await cardOf(page, 'Trip').locator('.note-open').click();
  const dlg = page.getByRole('dialog', { name: 'Trip' });
  await dlg.getByLabel('List item 3', { exact: true }).press('Alt+ArrowUp'); // Passport, with Socks and Charger, above Pack
  await until(async () => (await dlg.locator('input[aria-label^="List item 5"]').inputValue()) === 'Pack');
  await dlg.getByRole('button', { name: 'Close' }).last().click();
  await until(async () => (await items()) === 'Book train Passport >Socks >Charger Pack');
  await cardOf(page, 'Trip').getByLabel('Passport').click();
  await until(async () => (await items()) === 'Book train Passport* >Socks* >Charger* Pack');
});
await step('⋮ → Untick all, then Delete ticked items', async () => {
  await cardOf(page, 'Trip').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Untick all items' }).click();
  await until(async () => (await items()) === 'Book train Passport >Socks >Charger Pack');
  await cardOf(page, 'Trip').getByLabel('Socks').click();
  await until(async () => (await items()) === 'Book train Passport >Socks* >Charger Pack');
  await cardOf(page, 'Trip').getByLabel('Book train').click();
  await until(async () => (await items()) === 'Book train* Passport >Socks* >Charger Pack');
  await cardOf(page, 'Trip').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Delete ticked items (2)' }).click();
  await until(async () => (await items()) === 'Passport >Charger Pack');
  await page.screenshot({ path: `${SP}/shots/checklist-card.png` });
});
await step('Copy to Tasks: sub-items become steps', async () => {
  await cardOf(page, 'Trip').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Copy unticked items to Tasks' }).click();
  await page.locator('.toast', { hasText: '2 tasks added to My tasks' }).waitFor();
  const lists = (await api(page, 'GET', '/tasks/lists')).body.lists;
  const tasks = (await api(page, 'GET', `/tasks/lists/${lists[0].id}/tasks`)).body;
  const pp = tasks.find((t) => t.title === 'Passport');
  if (pp?.steps?.map((s) => s.title).join() !== 'Charger' || !tasks.some((t) => t.title === 'Pack')) throw new Error(JSON.stringify(tasks));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
