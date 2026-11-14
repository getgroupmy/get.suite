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
const btn = () => page.getByRole('button', { name: /^Unreads/ });
const group = (name) => page.getByRole('region', { name });
let gen, ch;
await step('all caught up', async () => {
  gen = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${gen}`);
  await btn().click();
  await page.getByText('You’re all caught up').waitFor();
});
await step('unread messages from several conversations, live, latest conversation first', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  ch = (await api(page, 'POST', '/chat/channels', { name: 'launch' })).body.id;
  dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  await api(kim, 'POST', `/chat/channels/${ch}/messages`, { body: 'launch is friday' });
  await api(kim, 'POST', `/chat/channels/${ch}/messages`, { body: 'press kit ready' });
  await group('#launch').getByText('press kit ready').waitFor();
  await group('#launch').getByText('2 new').waitFor();
  await btn().locator('.badge', { hasText: '2' }).waitFor();
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'got a minute?' });
  await group('Kim Park').getByText('got a minute?').waitFor();
  const order = await page.locator('.unread-group').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  if (order.join() !== 'Kim Park,#launch') throw new Error(order.join());
  await btn().locator('.badge', { hasText: '3' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/chat-unreads.png` });
});
await step('Mark read takes a conversation off', async () => {
  await group('#launch').getByRole('button', { name: 'Mark read' }).click();
  await until(async () => (await group('#launch').count()) === 0);
  await btn().locator('.badge', { hasText: '1' }).waitFor();
  if (await page.getByRole('button', { name: /launch/ }).locator('.badge').count()) throw new Error('still unread in the list');
});
await step('clicking a message opens it in its conversation and reads it', async () => {
  await group('Kim Park').getByText('got a minute?').click();
  await page.locator('.subnav-item.active', { hasText: 'Kim Park' }).waitFor();
  await page.locator('.msg', { hasText: 'got a minute?' }).waitFor();
  await until(async () => (await btn().locator('.badge').count()) === 0);
  await btn().click();
  await page.getByText('You’re all caught up').waitFor();
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
