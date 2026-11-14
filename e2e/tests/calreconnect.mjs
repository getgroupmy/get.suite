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
await step('calendar: an event added while the connection was down shows once it is back, without reloading', async () => {
  const other = await mk('olivia-phone'); await signIn(other, 'olivia@acme.com');
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = function (...a) { const s = new Real(...a); window.__sockets.push(s); return s; };
    window.WebSocket.prototype = Real.prototype;
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  });
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Create' }).waitFor();
  await page.waitForFunction(() => window.__sockets.some((s) => s.readyState === 1));
  await page.context().setOffline(true);
  await page.evaluate(() => window.__sockets.forEach((s) => s.close()));
  await page.waitForFunction(() => window.__sockets.every((s) => s.readyState === 3));
  const t = new Date(); t.setHours(11, 0, 0, 0);
  const r = await api(other, 'POST', '/events', { title: 'Added from my phone', start: t.getTime(), end: t.getTime() + 36e5 });
  if (r.status !== 201) throw new Error(`event ${r.status}`);
  await page.waitForTimeout(800);
  if (await page.getByText('Added from my phone').count()) throw new Error('shown while offline: the test is not dropping the connection');
  await page.context().setOffline(false);
  await page.getByText('Added from my phone').first().waitFor({ timeout: 40000 });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
