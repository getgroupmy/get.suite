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
const pill = () => page.getByRole('button', { name: /new messages?$/ });
const atEnd = () => page.locator('.messages').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 40);
await step('messages arriving while scrolled up show a button that goes down to them', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  for (let i = 1; i <= 30; i++) await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: `line ${i}` });
  await api(page, 'POST', `/chat/channels/${dm}/read`);
  await page.goto(`${B}/chat/${dm}`);
  await page.locator('.msg', { hasText: 'line 30' }).waitFor();
  await page.waitForTimeout(300);
  if (!await atEnd()) throw new Error('not at the end');
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'seen at once' });
  await page.locator('.msg', { hasText: 'seen at once' }).waitFor();
  await page.waitForTimeout(300);
  if (await pill().count()) throw new Error('button shown while at the end');
  if (!await atEnd()) throw new Error('did not follow');
  await page.locator('.messages').evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(200);
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'below one' });
  await pill().filter({ hasText: '↓ 1 new message' }).waitFor();
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'below two' });
  await pill().filter({ hasText: '↓ 2 new messages' }).waitFor();
  await api(page, 'POST', `/chat/channels/${dm}/messages`, { body: 'mine does not count' });
  await page.locator('.msg', { hasText: 'mine does not count' }).waitFor();
  await page.waitForTimeout(200);
  await pill().filter({ hasText: '↓ 2 new messages' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/chat-below.png` });
  await pill().click();
  await until(atEnd);
  await page.waitForTimeout(300);
  if (await pill().count()) throw new Error('button still there');
});
await step('scrolling down yourself takes it away too; opening another conversation starts afresh', async () => {
  await page.locator('.messages').evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(200);
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'below three' });
  await pill().waitFor();
  await page.locator('.messages').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await until(async () => (await pill().count()) === 0);
  await page.locator('.messages').evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(200);
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'below four' });
  await pill().waitFor();
  await page.getByRole('button', { name: /general/ }).click();
  await page.waitForTimeout(500);
  if (await pill().count()) throw new Error('carried over');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
