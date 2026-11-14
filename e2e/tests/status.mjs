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
await step('setup: a colleague', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
let dmId;
await step('Olivia sets a status from the account menu', async () => {
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  dmId = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  await api(page, 'POST', `/chat/channels/${dmId}/messages`, { body: 'Hello Kim' });
  await kim.goto(`${B}/chat/${dmId}`);
  await kim.getByText('Hello Kim').waitFor();
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Set a status' }).click();
  const d = page.getByRole('dialog', { name: 'Your status' });
  await d.getByRole('button', { name: '🌴 On holiday' }).click();
  if ((await d.getByLabel('Status').inputValue()) !== 'On holiday') throw new Error('preset text');
  if ((await d.getByLabel('Clear after').inputValue()) !== 'week') throw new Error('preset clear');
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByText(/^Status set: 🌴 On holiday until the end of /).waitFor();
  await page.locator('.avatar-status', { hasText: '🌴' }).waitFor();
});
await step('Kim sees it at once in Chat, and in Contacts', async () => {
  await kim.locator('.dm-status', { hasText: '🌴' }).waitFor();
  await kim.getByLabel('Their status').getByText(/🌴 On holiday · until the end of /).waitFor();
  await kim.screenshot({ path: `${SP}/shots/status-chat.png` });
  await kim.goto(`${B}/contacts`);
  await kim.getByRole('tab', { name: 'Directory' }).click();
  await kim.getByLabel('Status: 🌴 On holiday').waitFor();
});
await step('a custom status that doesn’t clear; then clearing it', async () => {
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Status: 🌴 On holiday' }).click();
  const d = page.getByRole('dialog', { name: 'Your status' });
  await d.getByLabel('Status').fill('Back at 3');
  await d.getByLabel('Clear after').selectOption('');
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Status set: 🌴 Back at 3').waitFor();
  const me = (await api(page, 'GET', '/users/me/status')).body.status;
  if (me.until !== null || me.text !== 'Back at 3') throw new Error(JSON.stringify(me));
  await kim.goto(`${B}/chat/${dmId}`);
  await kim.getByLabel('Their status').getByText('🌴 Back at 3').waitFor();
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Status: 🌴 Back at 3' }).click();
  await page.getByRole('dialog', { name: 'Your status' }).getByRole('button', { name: 'Clear status' }).click();
  await page.getByText('Status cleared').waitFor();
  await until(async () => (await kim.getByLabel('Their status').count()) === 0);
  if (await page.locator('.avatar-status').count()) throw new Error('emoji still on avatar');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
