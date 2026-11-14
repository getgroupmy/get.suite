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
let deck, code, kim, lee;
await step('presenting: ❓ starts the Q&A and shows where to ask', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' });
  deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'All hands' })).body;
  await page.goto(`${B}/slides/${deck.id}`);
  await page.getByRole('button', { name: /^Present/ }).first().click();
  const pres = page.getByRole('dialog', { name: 'Presenting' });
  await pres.waitFor();
  await pres.getByRole('button', { name: 'Audience questions' }).click({ force: true });
  const panel = page.getByRole('complementary', { name: 'Audience questions' });
  await panel.waitFor();
  const link = await panel.locator('.qa-link').textContent();
  code = link.split('/qa/')[1];
  if (!/^[a-z2-9]{6}$/.test(code)) throw new Error(link);
  await panel.getByText('No questions yet.').waitFor();
});
await step('colleagues ask and upvote at the link', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  lee = await mk('lee'); await signIn(lee, 'lee@acme.com');
  await kim.goto(`${B}/qa/${code}`);
  await kim.getByRole('heading', { name: 'All hands' }).waitFor();
  await kim.getByLabel('Your question').fill('When is the offsite?');
  await kim.getByRole('button', { name: 'Ask' }).click();
  await kim.getByText('When is the offsite?').waitFor();
  await lee.goto(`${B}/qa/${code}`);
  await lee.getByLabel('Your question').fill('Is there a bonus this year?');
  await lee.getByLabel('Ask without my name').check();
  await lee.getByRole('button', { name: 'Ask' }).click();
  await lee.getByText('Is there a bonus this year?').waitFor();
  // Kim sees Lee's (no name) within a few seconds, and upvotes it.
  const q = kim.locator('.qa-list li', { hasText: 'Is there a bonus this year?' });
  await q.waitFor({ timeout: 8000 });
  if (!/Anonymous/.test(await q.textContent())) throw new Error(await q.textContent());
  await q.getByRole('button', { name: 'Upvote (0)' }).click();
  await q.getByRole('button', { name: 'Take back upvote (1)' }).waitFor();
  const first = await kim.locator('.qa-list li .qa-body').first().textContent();
  if (first !== 'Is there a bonus this year?') throw new Error(`first: ${first}`);
  await kim.screenshot({ path: `${SP}/shots/qa-page.png` });
});
await step('the presenter sees them, most upvoted first, and marks one answered; then ends it', async () => {
  const panel = page.getByRole('complementary', { name: 'Audience questions' });
  await until(async () => (await panel.locator('.qa-list li').count()) === 2 && /▲ 1/.test(await panel.locator('.qa-list li').first().textContent()), 10000);
  const firstTxt = await panel.locator('.qa-list li').first().textContent();
  if (!/bonus/.test(firstTxt) || !/▲ 1/.test(firstTxt) || !/Anonymous/.test(firstTxt)) throw new Error(firstTxt);
  await page.screenshot({ path: `${SP}/shots/qa-presenting.png` });
  await panel.locator('.qa-list li').first().getByRole('button', { name: 'Mark answered' }).click();
  await until(async () => /offsite/.test(await panel.locator('.qa-list li').first().textContent()));
  await page.getByRole('dialog', { name: 'Presenting' }).locator('li.answered', { hasText: 'bonus' }).waitFor();
  // Kim's page shows it answered.
  await kim.locator('.qa-list li', { hasText: 'bonus' }).getByText('✓ Answered').waitFor({ timeout: 8000 });
  await panel.getByRole('button', { name: 'End Q&A' }).click();
  await kim.getByText('this Q&A has ended').waitFor({ timeout: 8000 });
  if (await kim.getByLabel('Your question').count()) throw new Error('no more asking');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
