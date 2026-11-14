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
const cards = (p) => p.locator('[aria-label="Notes"] article.note-card').evaluateAll((l) => l.map((a) => a.getAttribute('aria-label')).join(','));
const cardOf = (p, name) => p.getByRole('article', { name, exact: true });
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
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const ids = {};
  for (const t of ['Groceries', 'Ideas', 'Plumber', 'Books']) ids[t] = (await api(page, 'POST', '/notes', { title: t })).body.id;
  await api(page, 'PUT', `/notes/${ids.Ideas}/shares`, { user_ids: [kimId] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await api(kim, 'POST', '/notes', { title: 'Kim list' });
  for (const p of [page, kim]) { await p.goto(`${B}/notes`); await cardOf(p, 'Ideas').waitFor(); }
  if ((await cards(page)) !== 'Books,Plumber,Ideas,Groceries') throw new Error(await cards(page));
});
await step('drag a card onto another: it takes that place, and stays after a reload', async () => {
  await cardOf(page, 'Groceries').dragTo(cardOf(page, 'Plumber'));
  await until(async () => (await cards(page)) === 'Books,Groceries,Plumber,Ideas');
  await page.screenshot({ path: `${SP}/shots/noteorder.png` });
  await page.reload();
  await cardOf(page, 'Ideas').waitFor();
  await until(async () => (await cards(page)) === 'Books,Groceries,Plumber,Ideas');
});
await step('the person it is shared with keeps their own order', async () => {
  await kim.reload();
  await cardOf(kim, 'Ideas').waitFor();
  if ((await cards(kim)) !== 'Kim list,Ideas') throw new Error(await cards(kim));
  await cardOf(kim, 'Ideas').dragTo(cardOf(kim, 'Kim list'));
  await until(async () => (await cards(kim)) === 'Ideas,Kim list');
  await page.reload(); await cardOf(page, 'Ideas').waitFor();
  if ((await cards(page)) !== 'Books,Groceries,Plumber,Ideas') throw new Error('Olivia’s order changed: ' + await cards(page));
});
await step('⋮ → Move earlier / Move later, with the keyboard too', async () => {
  await cardOf(page, 'Ideas').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Move earlier' }).click();
  await until(async () => (await cards(page)) === 'Books,Groceries,Ideas,Plumber');
  await cardOf(page, 'Books').getByRole('button', { name: 'More' }).click();
  if (!(await page.getByRole('menuitem', { name: 'Move earlier' }).isDisabled())) throw new Error('first card cannot go earlier');
  await page.getByRole('menuitem', { name: 'Move later' }).click();
  await until(async () => (await cards(page)) === 'Groceries,Books,Ideas,Plumber');
});
await step('no moving while searching', async () => {
  await page.getByPlaceholder(/Search notes/).fill('o');
  await until(async () => (await page.locator('article.note-card[draggable=true]').count()) === 0 && (await page.locator('article.note-card').count()) > 0);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
