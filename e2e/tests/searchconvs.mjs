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
await step('search everything finds channels and direct messages by name', async () => {
  const kim = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Heron', password: 'password123' });
  if (kim.status !== 201) throw new Error(`user ${kim.status}`);
  const ch = (await api(page, 'POST', '/chat/channels', { name: 'heron-launch', topic: 'Launch plans for Heron' })).body;
  const dm = (await api(page, 'POST', '/chat/dm', { user_id: kim.body.id || kim.body.userId })).body;
  await page.goto(`${B}/drive`);
  await page.getByLabel('Search everything').fill('heron');
  const group = page.getByRole('group', { name: 'Conversations' });
  await group.waitFor({ timeout: 10000 });
  await group.getByRole('option', { name: /#heron-launch.*Launch plans for Heron/ }).waitFor();
  await group.getByRole('option', { name: /Kim Heron.*Direct message/ }).waitFor();
  await page.screenshot({ path: `${SP}/shots/search-convs.png` });
  await group.getByRole('option', { name: /#heron-launch/ }).click();
  await page.waitForURL(`**/chat/${ch.id}`);
  await page.getByText('Launch plans for Heron').first().waitFor();
  await page.getByLabel('Search everything').fill('kim heron');
  await page.getByRole('group', { name: 'Conversations' }).getByRole('option', { name: /Kim Heron/ }).click();
  await page.waitForURL(`**/chat/${dm.id}`);
});
await step('search everything finds comments and opens the file at the comment', async () => {
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Pricing memo' })).body;
  await api(page, 'POST', `/comments/${doc.id}`, { body: 'Check the Kingfisher discount', anchor: { quote: 'k' }, id: 'thread-search-1' });
  await page.goto(`${B}/drive`);
  await page.getByLabel('Search everything').fill('kingfisher');
  const group = page.getByRole('group', { name: 'Comments' });
  await group.waitFor({ timeout: 10000 });
  await group.getByRole('option', { name: /Check the Kingfisher discount.*on “Pricing memo”/ }).click();
  await page.waitForURL(/\/docs\/.+\?comment=thread-search-1/);
  await page.locator('.comment-thread.active', { hasText: 'Kingfisher' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
