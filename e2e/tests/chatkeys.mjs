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
const ch = {};
const heading = (name) => page.getByRole('heading', { name, exact: true }).first();
const at = async (name) => { await page.locator('.subnav-item.active', { hasText: name }).waitFor(); };
await step('Alt+↑/↓ moves through the conversation list', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const n of ['alpha', 'beta']) ch[n] = (await api(page, 'POST', '/chat/channels', { name: n })).body.id;
  ch.general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  await page.goto(`${B}/chat/${ch.alpha}`);
  await at('alpha');
  const box = page.getByPlaceholder(/Message/).first();
  await box.click();
  await page.keyboard.press('Alt+ArrowDown'); await at('beta');
  await page.keyboard.press('Alt+ArrowDown'); await at('general');
  await page.keyboard.press('Alt+ArrowDown'); await at('Kim Park');
  await page.keyboard.press('Alt+ArrowDown'); await at('Kim Park'); // the end
  await page.keyboard.press('Alt+ArrowUp'); await at('general');
});
await step('Alt+Shift+↓ goes to the next unread conversation, round past the end', async () => {
  await page.goto(`${B}/chat/${ch.beta}`);
  await at('beta');
  await api(kim, 'POST', `/chat/channels/${ch.alpha}/messages`, { body: 'in alpha' });
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'in the dm' });
  await page.getByRole('button', { name: /Kim Park/ }).locator('.badge').waitFor();
  await page.keyboard.press('Alt+Shift+ArrowDown'); await at('Kim Park');
  await page.locator('.msg', { hasText: 'in the dm' }).waitFor();
  await page.keyboard.press('Alt+Shift+ArrowDown'); await at('alpha');
  await page.locator('.msg', { hasText: 'in alpha' }).waitFor();
  await page.waitForTimeout(500);
  await page.keyboard.press('Alt+Shift+ArrowDown');
  await page.getByText('Nothing else is unread').waitFor();
  await at('alpha');
});
await step('↑ in an empty box changes your last message', async () => {
  const box = page.getByPlaceholder(/Message/).first();
  await box.fill('meet at noen');
  await box.press('Enter');
  await page.locator('.msg', { hasText: 'meet at noen' }).waitFor();
  await box.fill('x'); await box.press('ArrowUp');
  if (await page.getByLabel('Change the message').count()) throw new Error('edited with text in the box');
  await box.fill('');
  await box.press('ArrowUp');
  const edit = page.getByLabel('Change the message');
  await edit.waitFor();
  if ((await edit.inputValue()) !== 'meet at noen') throw new Error(await edit.inputValue());
  await edit.fill('meet at noon');
  await edit.press('Enter');
  await page.locator('.msg', { hasText: 'meet at noon' }).getByText('(edited)').waitFor();
});
await step('Shift+Esc marks everything read; the shortcuts list has them', async () => {
  await api(kim, 'POST', `/chat/channels/${ch.beta}/messages`, { body: 'b1' });
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'd1' });
  await page.getByRole('button', { name: /Kim Park/ }).locator('.badge').waitFor();
  await page.keyboard.press('Shift+Escape');
  await page.getByText('Marked 2 conversations as read').waitFor();
  await until(async () => (await page.locator('.subnav .badge').count()) === 0);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+/');
  await page.getByText('Previous or next unread conversation').waitFor();
  await page.getByText('Change your last message').waitFor();
  await page.screenshot({ path: `${SP}/shots/chat-keys.png` });
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
