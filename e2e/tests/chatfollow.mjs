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
const threadsBtn = () => page.getByRole('button', { name: /^Threads/ });
const kimRow = () => page.getByRole('button', { name: /Kim Park/ });
let p1, gen;
await step('follow a thread you have not replied to', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  dm = (await api(kim, 'POST', '/chat/dm', { user_id: (await api(page, 'GET', '/auth/me')).body.user.id })).body.id;
  p1 = (await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'design question' })).body.id;
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'first thought', parent_id: p1 });
  await page.goto(`${B}/chat/${dm}?msg=${p1}&thread=${p1}`);
  const panel = page.getByRole('complementary', { name: 'Thread' });
  await panel.getByText('first thought').waitFor();
  await panel.getByRole('button', { name: 'Follow', exact: true }).click();
  await page.getByText('Following this thread').waitFor();
  await panel.getByRole('button', { name: '✓ Following' }).waitFor();
  await threadsBtn().click();
  await page.getByRole('list', { name: 'Your threads' }).getByText('design question').waitFor();
  await page.screenshot({ path: `${SP}/shots/chat-follow.png` });
});
await step('its replies then count as unread, live', async () => {
  gen = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${gen}`);
  await page.getByRole('heading', { name: /general/ }).first().waitFor();
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'second thought', parent_id: p1 });
  await kimRow().locator('.badge', { hasText: /^1$/ }).waitFor();
  await threadsBtn().locator('.badge', { hasText: '1' }).waitFor();
});
await step('unfollow: replies stop counting and it leaves Threads', async () => {
  await page.goto(`${B}/chat/${dm}?msg=${p1}&thread=${p1}`);
  const panel = page.getByRole('complementary', { name: 'Thread' });
  await panel.getByRole('button', { name: '✓ Following' }).click();
  await page.getByText('Unfollowed: its replies won’t count as unread for you').waitFor();
  await panel.getByRole('button', { name: 'Follow', exact: true }).waitFor();
  await threadsBtn().click();
  await page.getByText('No threads yet').waitFor();
  await page.goto(`${B}/chat/${gen}`);
  await page.getByRole('heading', { name: /general/ }).first().waitFor();
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'third thought', parent_id: p1 });
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'a new message' });
  await kimRow().locator('.badge', { hasText: /^1$/ }).waitFor();
  await page.waitForTimeout(800);
  if ((await kimRow().locator('.badge').innerText()) !== '1') throw new Error('reply counted');
});
await step('replying yourself follows a thread (on the other side)', async () => {
  const p2 = (await api(page, 'POST', `/chat/channels/${dm}/messages`, { body: 'olivia asks' })).body.id;
  await kim.goto(`${B}/chat/${dm}?msg=${p2}&thread=${p2}`);
  const panel = kim.getByRole('complementary', { name: 'Thread' });
  await panel.getByRole('button', { name: 'Follow', exact: true }).waitFor();
  const box = panel.getByPlaceholder(/Reply/);
  await box.fill('kim answers');
  await box.press('Enter');
  await panel.getByRole('button', { name: '✓ Following' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
