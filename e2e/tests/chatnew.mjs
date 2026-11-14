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
const sep = () => page.getByRole('separator', { name: 'New messages' });
const inView = (loc) => loc.evaluate((el) => { const s = el.closest('.messages').getBoundingClientRect(), r = el.getBoundingClientRect(); return r.top >= s.top - 1 && r.bottom <= s.bottom + 1; });
await step('a line marks where the new messages start, and the view goes there', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  for (const t of ['old one', 'old two']) { await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: t }); await page.waitForTimeout(10); }
  await api(page, 'POST', `/chat/channels/${dm}/messages`, { body: 'my answer' });
  await api(page, 'POST', `/chat/channels/${dm}/read`);
  for (let i = 1; i <= 30; i++) { await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: `news ${i}` }); await page.waitForTimeout(5); }
  await page.goto(`${B}/chat`);
  await page.getByRole('button', { name: /Kim Park/ }).locator('.badge', { hasText: /^30$/ }).waitFor();
  await page.getByRole('button', { name: /Kim Park/ }).click();
  await sep().waitFor();
  if ((await sep().innerText()).trim() !== 'New messages · 30') throw new Error(await sep().innerText());
  await page.waitForTimeout(300);
  if (!await inView(sep())) throw new Error('line not in view');
  if (!await inView(page.locator('.msg', { hasText: /news 1(?!\d)/ }).first())) throw new Error('first new message not in view');
  if (await inView(page.locator('.msg', { hasText: 'news 30' }))) throw new Error('jumped to the end instead');
  const before = await page.locator('.messages').evaluate((el) => [...el.querySelectorAll('.new-sep, .msg')].map((x) => x.classList.contains('new-sep') ? 'LINE' : x.innerText.match(/old one|old two|my answer|news \d+/)?.[0]).slice(0, 5));
  if (before.join() !== 'old one,old two,my answer,LINE,news 1') throw new Error(before.join());
  await page.screenshot({ path: `${SP}/shots/chat-new-line.png` });
});
await step('messages arriving while it is open go under it; read, the line is gone next time', async () => {
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'live one' });
  await page.locator('.msg', { hasText: 'live one' }).waitFor();
  if ((await sep().count()) !== 1) throw new Error('line count');
  await page.goto(`${B}/chat`);
  await page.getByRole('button', { name: /Kim Park/ }).click();
  await page.locator('.msg', { hasText: 'live one' }).waitFor();
  await page.waitForTimeout(400);
  if (await sep().count()) throw new Error('line still there');
  if (!await inView(page.locator('.msg', { hasText: 'live one' }))) throw new Error('not at the end');
});
await step('mark unread from here puts the line above that message', async () => {
  const msg = page.locator('.msg', { hasText: 'news 29' });
  await msg.hover();
  await msg.getByRole('button', { name: 'Mark unread from here' }).click();
  await page.waitForURL(/\/chat$/);
  await page.getByRole('button', { name: /Kim Park/ }).locator('.badge', { hasText: /^3$/ }).waitFor();
  await page.getByRole('button', { name: /Kim Park/ }).click();
  await sep().waitFor();
  if ((await sep().innerText()).trim() !== 'New messages · 3') throw new Error(await sep().innerText());
  const next = await sep().evaluate((el) => el.parentElement.querySelector('.msg')?.innerText || '');
  if (!/news 29/.test(next)) throw new Error(next);
});
await step('a brand new conversation has no line above its first message', async () => {
  const danId = (await api(page, 'POST', '/users', { local: 'dan', domain: 'acme.com', name: 'Dan Lee', password: 'password123' })).body.id;
  const dan = await mk('dan'); await signIn(dan, 'dan@acme.com');
  const d = (await api(dan, 'POST', '/chat/dm', { user_id: (await api(page, 'GET', '/auth/me')).body.user.id })).body.id;
  await api(dan, 'POST', `/chat/channels/${d}/messages`, { body: 'hi there' });
  await page.goto(`${B}/chat/${d}`);
  await page.locator('.msg', { hasText: 'hi there' }).waitFor();
  await page.waitForTimeout(300);
  if (await sep().count()) throw new Error('line shown');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
