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
const search = () => page.getByLabel('Search everything');
const actions = () => page.getByRole('group', { name: 'Actions' });
const first = () => actions().getByRole('option').first();
const box = () => page.getByLabel('Message', { exact: true });
let kimId;
await step('a colleague and a channel', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  kimId = r.body.id;
  const c = await api(page, 'POST', '/chat/channels', { name: 'launch' });
  if (c.status !== 201 && c.status !== 200) throw new Error(JSON.stringify(c));
});
await step('"chat @kim …" opens the direct message with the words in the box, not sent', async () => {
  await page.goto(`${B}/home`);
  await search().fill('chat @kim Are we still on for 3?');
  await until(async () => (await first().textContent().catch(() => '')).startsWith('Message Kim Park: Are we still on for 3?'));
  await search().press('ArrowDown');
  await search().press('Enter');
  await page.waitForURL(/\/chat\//);
  await until(async () => (await box().inputValue().catch(() => '')) === 'Are we still on for 3?');
  const id = page.url().split('/chat/')[1].split(/[?#]/)[0];
  if ((await api(page, 'GET', `/chat/channels/${id}/messages`)).body.length) throw new Error('sent');
});
await step('from Chat itself, again: added under the draft already there', async () => {
  await search().fill('dm @kim Bring the figures');
  await until(async () => (await first().textContent().catch(() => '')).startsWith('Message Kim Park: Bring the figures'));
  await first().click();
  await until(async () => (await box().inputValue().catch(() => '')) === 'Are we still on for 3?\nBring the figures');
});
await step('"chat #launch …" opens the channel with the words', async () => {
  await search().fill('chat #launch Shipped it!');
  await until(async () => (await first().textContent().catch(() => '')).startsWith('Message #launch: Shipped it!'));
  await first().click();
  await page.getByRole('heading', { name: /launch/ }).first().waitFor();
  await until(async () => (await box().inputValue().catch(() => '')) === 'Shipped it!');
  await page.screenshot({ path: `${SP}/shots/search-chat.png` });
});
await step('nobody named: no chat action', async () => {
  await search().fill('chat about the launch');
  await page.waitForTimeout(400);
  if (await actions().count() && /^(Message|Open chat)/.test(await first().textContent())) throw new Error('offered');
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
