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
let dm;
const btn = () => page.getByRole('button', { name: /^@\s*Mentions|^Mentions/ });
const list = () => page.getByRole('list', { name: 'Mentions of you' });
let gen, ch;
await step('none yet', async () => {
  gen = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${gen}`);
  await btn().click();
  await page.getByText('No mentions yet').waitFor();
});
await step('mentions arrive live, newest first, marked new until read', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  ch = (await api(page, 'POST', '/chat/channels', { name: 'launch' })).body.id;
  await api(page, 'POST', `/chat/channels/${ch}/read`);
  await api(kim, 'POST', `/chat/channels/${ch}/messages`, { body: 'nothing for olivia' });
  await api(kim, 'POST', `/chat/channels/${ch}/messages`, { body: 'can you check this @olivia@acme.com' });
  await list().getByText('can you check this @olivia@acme.com').waitFor();
  await btn().locator('.badge', { hasText: '1' }).waitFor();
  await api(kim, 'POST', `/chat/channels/${ch}/messages`, { body: 'heads up @channel' });
  await btn().locator('.badge', { hasText: '2' }).waitFor();
  const items = await list().locator('li').allInnerTexts();
  if (items.length !== 2 || !/heads up/.test(items[0]) || !/#launch/.test(items[0])) throw new Error(items.join(' | '));
  if (items.some((t) => /nothing for olivia/.test(t))) throw new Error('unrelated message listed');
  await page.screenshot({ path: `${SP}/shots/chat-mentions.png` });
});
await step('clicking one opens it; its conversation read, the count goes', async () => {
  await list().getByText('can you check this').click();
  await page.locator('.subnav-item.active', { hasText: 'launch' }).waitFor();
  await page.locator('.msg.found, .msg', { hasText: 'can you check this' }).first().waitFor();
  await until(async () => (await btn().locator('.badge').count()) === 0);
  await btn().click();
  await list().waitFor();
  if (await list().locator('.unread').count()) throw new Error('still new');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
