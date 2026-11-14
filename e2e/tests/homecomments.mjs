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
let kim, docA, docB, kimId;
await step('Home shows the comments for you across files and opens one at its comment', async () => {
  kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  docA = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Budget memo' })).body;
  docB = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Q4 numbers' })).body;
  for (const d of [docA, docB]) await api(page, 'PUT', `/files/${d.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await api(page, 'POST', `/comments/${docA.id}`, { body: 'Can you check the totals @kim@acme.com', anchor: { quote: 't' }, id: 'thread-home-1' });
  await api(page, 'POST', `/comments/${docB.id}`, { body: 'Fill in October', anchor: { sheet: 0, cell: 'B2' }, id: 'thread-home-2', assign: kimId });
  await api(page, 'POST', `/comments/${docA.id}`, { body: 'Not for Kim', anchor: { quote: 'n' }, id: 'thread-home-3' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/home`);
  const card = kim.getByRole('region', { name: 'Comments for you' });
  await card.getByText('Budget memo').waitFor();
  await card.getByText(/Olivia Owner assigned you: Fill in October/).waitFor();
  if (await card.getByText('Not for Kim').count()) throw new Error('shows others');
  await kim.screenshot({ path: `${SP}/shots/home-comments.png` });
  await card.getByRole('link', { name: /Budget memo/ }).click();
  await kim.waitForURL(/\/docs\/.+\?comment=thread-home-1/);
  await kim.locator('.comment-thread.active', { hasText: 'Can you check the totals' }).waitFor();
});
await step('an editor isn’t offered deleting someone else’s comment; the card updates when it’s resolved', async () => {
  const kp = kim.getByRole('complementary', { name: 'Comments' });
  if (await kp.getByRole('button', { name: 'Delete comment by Olivia Owner' }).count()) throw new Error('delete offered to an editor');
  await kp.getByRole('button', { name: 'Resolve' }).click();
  await kim.goto(`${B}/home`);
  const card = kim.getByRole('region', { name: 'Comments for you' });
  await card.getByText('Q4 numbers').waitFor();
  if (await card.getByText('Budget memo').count()) throw new Error('resolved still shown');
  // Live: Olivia mentions Kim on another file while Home is open.
  await api(page, 'POST', `/comments/${docB.id}`, { body: 'Also @kim@acme.com see C3', anchor: { sheet: 0, cell: 'C3' } });
  await card.getByText(/see C3/).waitFor({ timeout: 10000 });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
