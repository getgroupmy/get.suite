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
  p.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed|ERR_INTERNET_DISCONNECTED/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
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
await step('chat: messages sent while the connection was down show once it is back, without reopening the conversation', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (r.status !== 201) throw new Error(`user ${r.status}`);
  const kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  const dm = (await api(page, 'POST', '/chat/dm', { user_id: r.body.id })).body.id;
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'first one' });
  // Keep hold of the page's live connections, to drop them.
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = function (...a) { const s = new Real(...a); window.__sockets.push(s); return s; };
    window.WebSocket.prototype = Real.prototype;
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  });
  await page.goto(`${B}/chat/${dm}`);
  await page.locator('.msg', { hasText: 'first one' }).waitFor();
  await page.waitForFunction(() => window.__sockets.some((s) => s.readyState === 1));
  // Drop the connection, and keep it down (offline) while Kim writes.
  await page.context().setOffline(true);
  await page.evaluate(() => window.__sockets.forEach((s) => s.close()));
  await page.waitForFunction(() => window.__sockets.every((s) => s.readyState === 3));
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'sent while you were away' });
  await page.waitForTimeout(800);
  if (await page.locator('.msg', { hasText: 'sent while you were away' }).count()) throw new Error('arrived while offline: the test is not dropping the connection');
  await page.context().setOffline(false);
  await page.locator('.msg', { hasText: 'sent while you were away' }).waitFor({ timeout: 40000 });
  // And it keeps working live after that.
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'and now live again' });
  await page.locator('.msg', { hasText: 'and now live again' }).waitFor({ timeout: 10000 });
  if ((await page.locator('.msg', { hasText: 'first one' }).count()) !== 1) throw new Error('doubled');
});
await step('chat: a bookmark added while the connection was down shows once it is back', async () => {
  const dm = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.dm_key && c.dm_name === 'Kim Park').id;
  const kim = await mk('kim2'); await signIn(kim, 'kim@acme.com');
  await page.waitForFunction(() => window.__sockets.some((s) => s.readyState === 1));
  await page.context().setOffline(true);
  await page.evaluate(() => window.__sockets.forEach((s) => s.close()));
  await page.waitForFunction(() => window.__sockets.every((s) => s.readyState === 3));
  const r = await api(kim, 'POST', `/chat/channels/${dm}/bookmarks`, { title: 'Launch plan', url: 'https://example.com/plan' });
  if (r.status >= 300) throw new Error(`bookmark ${r.status}`);
  await page.waitForTimeout(800);
  if (await page.getByRole('link', { name: 'Launch plan' }).count()) throw new Error('shown while offline');
  await page.context().setOffline(false);
  await page.getByRole('link', { name: 'Launch plan' }).waitFor({ timeout: 40000 });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
