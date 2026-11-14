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
let ch, kim;
await step('setup: a channel and a colleague', async () => {
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
  ch = (await api(page, 'POST', '/chat/channels', { name: 'office' })).body.id;
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Morning all' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/chat/${ch}`); await p.getByText('Morning all').waitFor(); }
});
await step('Remind me about this on a message: In 1 hour shows on it; Cancel takes it off', async () => {
  const msg = page.locator('.msg', { hasText: 'Morning all' });
  await msg.hover();
  await msg.getByRole('button', { name: 'Remind me about this' }).click();
  await page.getByRole('menuitem', { name: /^In 1 hour/ }).click();
  await page.getByText(/^I'll remind you today at|^I'll remind you tomorrow at/).first().waitFor();
  await msg.locator('.msg-reminder').waitFor();
  await page.screenshot({ path: `${SP}/shots/chat-remind.png` });
  await msg.locator('.msg-reminder').getByRole('button', { name: 'Cancel' }).click();
  await msg.locator('.msg-reminder').waitFor({ state: 'detached' });
});
await step('a reminder that comes due arrives on the bell and leads back to the message', async () => {
  const id = (await api(page, 'GET', `/chat/channels/${ch}/messages`)).body.find((m) => m.body === 'Morning all').id;
  const r = await api(page, 'POST', `/chat/messages/${id}/remind`, { at: Date.now() + 31e3 });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: /^Notifications, 1 new/ }).waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await page.getByText(/^Reminder: Olivia Owner in #office/).click();
  await page.waitForURL(new RegExp(`/chat/${ch}`));
  await page.locator(`[data-mid="${id}"]`).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
