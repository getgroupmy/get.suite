import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
let ch;
await step('an admin chooses to keep chat for 30 days; it is logged and today’s messages stay', async () => {
  ch = (await api(page, 'POST', '/chat/channels', { name: 'keeping' })).body;
  const id = ch.id || ch.channel?.id;
  await api(page, 'POST', `/chat/channels/${id}/messages`, { body: 'Hello there' });
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Company settings' }).click();
  const pick = page.getByLabel('Keep chat messages');
  if (await pick.inputValue() !== '0') throw new Error('default');
  await pick.selectOption('30');
  await page.getByText('Chat messages older than 30 days will be deleted').waitFor();
  await until(async () => (await api(page, 'GET', '/orgs/current')).body.chat_days === 30);
  // Today's messages stay.
  const msgs = (await api(page, 'GET', `/chat/channels/${id}/messages`)).body;
  if (!msgs.some((m) => m.body === 'Hello there')) throw new Error('gone too soon');
  const log = (await api(page, 'GET', '/audit?limit=20')).body;
  const entries = Array.isArray(log) ? log : log.entries || log.items || [];
  if (!JSON.stringify(entries).includes('chat_days')) throw new Error('not in the activity log');
  await pick.selectOption('0');
  await page.getByText('Chat messages are kept for good').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
