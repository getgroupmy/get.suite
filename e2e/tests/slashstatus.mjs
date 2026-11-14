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
const pad = (n) => String(n).padStart(2, '0');
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
let general;
const box = () => page.getByLabel('Message', { exact: true });
const badge = () => page.locator('.avatar-btn .avatar-status');
const mine = async () => (await api(page, 'GET', '/users/me/status')).body.status;
await step('/status sets your status at once; nothing is posted', async () => {
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${general}`);
  await box().fill('/st');
  await page.getByRole('listbox', { name: 'Commands' }).getByRole('option', { name: /\/status/ }).waitFor();
  await box().fill('/status 🍔 Lunch 1h');
  const before = Date.now();
  await box().press('Enter');
  await page.getByText(/^Status: 🍔 Lunch until /).waitFor();
  await until(async () => (await badge().textContent().catch(() => '')) === '🍔');
  const s = await mine();
  if (s.text !== 'Lunch' || Math.abs(s.until - before - 3600e3) > 60e3) throw new Error(JSON.stringify(s));
  if (await box().inputValue() !== '') throw new Error('box not cleared');
  if (await page.locator('.messages').getByText('Lunch').count()) throw new Error('posted');
  if (!/🍔 Lunch/.test(await page.getByRole('button', { name: 'Account' }).getAttribute('title'))) throw new Error('title');
});
await step('/status with words only, for this week', async () => {
  await box().fill('/status At the Leeds office this week');
  await box().press('Enter');
  await page.getByText(/^Status: 💬 At the Leeds office until the end of /).waitFor();
  const s = await mine();
  if (s.text !== 'At the Leeds office' || s.emoji !== '💬') throw new Error(JSON.stringify(s));
  if (new Date(s.until).getDay() !== 1 || new Date(s.until).getHours() !== 0) throw new Error(new Date(s.until).toString());
});
await step('/status in a thread works too, and /status alone clears it', async () => {
  const top = (await api(page, 'POST', `/chat/channels/${general}/messages`, { body: 'Anyone around?' })).body;
  const m = page.locator(`[data-mid="${top.id}"]`);
  await m.waitFor();
  await m.hover();
  await m.getByRole('button', { name: 'Reply in thread' }).click();
  const reply = page.getByRole('complementary', { name: 'Thread' }).getByLabel('Reply', { exact: true });
  await reply.fill('/status 🎯 Focusing for 90 minutes');
  await reply.press('Enter');
  await until(async () => (await badge().textContent().catch(() => '')) === '🎯');
  const s = await mine();
  if (Math.abs(s.until - Date.now() - 90 * 60e3) > 60e3) throw new Error(JSON.stringify(s));
  await reply.fill('/status');
  await reply.press('Enter');
  await page.getByText('Status cleared').waitFor();
  await badge().waitFor({ state: 'detached' });
  if (await mine()) throw new Error('still set');
});
await step('a /status without words: an error, the text stays', async () => {
  await box().fill('/status 2h');
  await box().press('Enter');
  await page.getByText('Write it as /status 🍔 Lunch 1h').waitFor();
  if (await box().inputValue() !== '/status 2h') throw new Error(await box().inputValue());
  await page.screenshot({ path: `${SP}/shots/slash-status.png` });
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
